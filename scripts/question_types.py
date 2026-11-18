"""Conservative, shared public-question categories; never inspect answers."""

import re


def evidence(field, pattern, text):
    match = re.search(pattern, text, re.I)
    if not match:
        return None
    return {"field": field, "rule": pattern, "excerpt": text[max(0, match.start() - 45):min(len(text), match.end() + 90)]}


def classify(question):
    # Lazy import keeps normalization and played joins on one classifier.
    from gotquestions_public import plain_text
    text = plain_text(question.get("text"))
    handout_text = plain_text(question.get("razdatkaText"))
    note = plain_text(question.get("note"))
    form = plain_text(question.get("form"))
    handout_fields = [name for name in ("razdatkaText", "razdatkaPic", "razdatkaPicGeneric") if question.get(name)]
    handout = "with" if handout_fields else "without"
    handout_evidence = [{"field": name, "rule": "nonempty_published_handout_field", "excerpt": plain_text(question[name])[:160]} for name in handout_fields]
    # Format terms must act as reading instructions near the opening. A story
    # that merely mentions a blitz is not a format declaration.
    format_text = text or handout_text
    format_field = "text" if text else "razdatkaText"
    opening = re.sub(r"\[[^\]]*\]", " ", format_text[:1500]).strip()
    intro = opening[:800]
    terms = [("tetra", r"\bтетра[\s\-‐‑‒–—]?блиц\b"), ("duplet", r"\bдуплет\b"), ("blitz", r"(?<!тетра )(?<![\-‐‑‒–—а-я])\bблиц\b")]
    format_hits = []
    for key, pattern in terms:
        # The declaration itself is anchored before the optional «вопрос-».
        # Its final dash must not trip blitz's mixed-text lookbehind, while
        # «тетра-блиц» still cannot match a declaration beginning with «блиц».
        declared_term = r"\bблиц\b" if key == "blitz" else pattern
        declaration = (r"(?:^|[\n.!?]\s*)\s*(?:внимание[!.,:]?\s*)?"
                       r"(?:вопрос\s*[\-‐‑‒–—]\s*)?" + declared_term +
                       r"(?=\s*(?:$|[(.,:;!—–-]|\d|два\s+вопрос|три\s+вопрос|четыре\s+вопрос))")
        hit = None
        for field, value in ((format_field, intro), ("note", note)):
            hit = evidence(field, declaration, value)
            # Random selection of a format is an explicit mixed instruction.
            if not hit and re.search(r"(?:если\s+выпадет|кину\s+кубик|брос[а-я]*\s+кубик)", value, re.I) and re.search(r"врем[а-я]*\s+обсужд[а-я]*", value, re.I):
                hit = evidence(field, pattern, value)
            if hit:
                break
        if hit:
            format_hits.append((key, hit))
    unusual = re.search(r"\b(?:триплет|квадруплет|икоситетра[\s\-‐‑‒–—]?блиц|пента[\s\-‐‑‒–—]?блиц)\b", intro + " " + note, re.I)
    kind = format_hits[0][0] if len(format_hits) == 1 and not unusual else "other" if format_hits or unusual or not (format_text or note) else "ordinary"
    format_evidence = [hit for _, hit in format_hits]
    if unusual:
        format_evidence.append({"field": "text_or_note", "rule": "other_multiquestion_format", "excerpt": unusual.group(0)})
    if kind == "ordinary":
        format_evidence = [{"field": "text,note", "rule": "no_explicit_multiquestion_instruction", "excerpt": "В начале текста и примечании не найдено указание на составной формат."}]
    elif kind == "other" and not format_evidence:
        format_evidence = [{"field": "text,razdatkaText,note", "rule": "missing_reading_instructions", "excerpt": "Текст и инструкции в источнике отсутствуют; формат неизвестен."}]
    # These are overlapping, explicit language cues, not semantic guesses.
    # Word boundaries deliberately exclude «согласно» from «гласные».
    rules = [
        ("same_vowels", r"\b(?:все\s+)?(?:(?:обе|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d+)\s+)?гласн[а-я]*\s+(?:букв[а-я]*\s+)?одинаков[а-я]*|\bодинаков[а-я]*\s+гласн[а-я]*|\bиз\s+гласн[а-я]*\s+(?:есть\s+)?только\s+(?:(?:две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d+)\s+)?букв[а-я]*\s+[«\"„“]?[аеёиоуыэюя](?:[»\"”]|\b)"),
        ("paired_initials", r"\bпарн[а-я]*\s+(?:начальн[а-я]*\s+)?(?:букв[а-я]*|согласн[а-я]*)"),
        ("same_initials", r"\bначина[а-я]*\s+на\s+(?:одну\s+и\s+ту\s+же|одинаков[а-я]*)\s+букв[а-я]*|\b(?:одинаков[а-я]*|совпадающ[а-я]*)\s+инициал[а-я]*"),
        ("adjacent_initials", r"\b(?:начина[а-я]*\s+на\s+)?соседн[а-я]*\s+букв[а-я]*"),
        ("same_endings", r"\b(?:одинаков[а-я]*|совпадающ[а-я]*)\s+окончан[а-я]*|\bзаканчива[а-я]*\s+(?:на\s+)?(?:одинаков[а-я]*|одн[а-я]*\s+и\s+т[а-я]*\s+же)"),
        ("rhyme", r"\b(?:рифмующ[а-я]*|зарифмован[а-я]*|в\s+рифму|рифм[а-я]*\s+слов[а-я]*)"),
        ("anagram", r"\bанаграмм[а-я]*"),
        ("palindrome", r"\bпалиндром[а-я]*"),
        ("word_length", r"\b(?:слов[а-я]*\s+из|из\s+(?:\d+|тр[её]х|четыр[её]х|пяти|шести|семи|восьми|девяти|десяти))\s+(?:\d+\s+)?букв[а-я]*"),
    ]
    forms, form_evidence = [], []
    for key, pattern in rules:
        for field, value in (("text", text), ("razdatkaText", handout_text), ("note", note), ("form", form)):
            if key in ("anagram", "palindrome") and field != "form":
                # Bare mentions can describe the story's subject. Require an
                # answer instruction or an explicit relationship of replaced
                # answer words; source `form` is already structured metadata.
                stem = "анаграмм" if key == "anagram" else "палиндром"
                instruction = (r"\b(?:назовите|напишите|запишите|дайте|ответьте|укажите|заполните|закончите)\b[^.!?\n]{0,240}\b" + stem +
                               r"(?:ами|ой|ом|у|а)?\b|\b(?:икс[а-я]*|игрек[а-я]*|альф[а-я]*|перв[а-я]*|втор[а-я]*|ответ[а-я]*)\b[^.!?\n]{0,100}\b" + stem + r"[а-я]*\b")
                hit = evidence(field, instruction, value)
            else:
                hit = evidence(field, pattern, value)
            if hit:
                forms.append(key)
                form_evidence.append({"category": key, **hit})
                break
    if not forms:
        forms = ["unmarked"]
    return {"handout": handout, "format": kind, "forms": forms,
            "evidence": {"handout": handout_evidence, "format": format_evidence, "forms": form_evidence}}


