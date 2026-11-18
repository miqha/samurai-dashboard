"""Read public GotQuestions page data without executing page JavaScript.

The published pack page embeds the same complete record rendered by the site in
Next.js Flight JSON. This module only parses that public response. It performs
no network requests, guesses no endpoints and does not omit unusual questions.
"""

from datetime import datetime
from html import unescape
from html.parser import HTMLParser
import json
import math
import re
from urllib.parse import urljoin, urlparse

GQ = "https://gotquestions.online"
NONSTANDARD = re.compile(r"\b(?:дуплет|блиц|триплет)\b", re.I)
BLOCKS = {"p", "div", "section", "article", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "tr"}


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inside = False
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.inside = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.inside = False

    def handle_data(self, data):
        if self.inside:
            self.scripts.append(data)


def extract_next(document):
    """Return joined public Next.js Flight records; never eval the scripts."""
    parser = _Scripts()
    parser.feed(document)
    chunks = []
    for source in parser.scripts:
        source = source.strip().removesuffix(";")
        prefix = "self.__next_f.push("
        if not source.startswith(prefix) or not source.endswith(")"):
            continue
        value = json.loads(source[len(prefix):-1])
        if isinstance(value, list) and len(value) > 1 and value[0] == 1 and isinstance(value[1], str):
            chunks.append(value[1])
    if not chunks:
        raise ValueError("Public Next.js data not found")
    return "".join(chunks)


def _flight_records(source):
    """Read UTF-8 byte-counted text records and ordinary one-line model records.

    Long published comments are emitted as `1a:T920,<2336 UTF-8 bytes>` and
    referenced by `$1a` from the pack object. A text record need not end with a
    newline, so scanning for line prefixes alone silently loses adjacent texts.
    """
    payload = source.encode("utf-8")
    position = 0
    texts, models, outlined = {}, [], {}
    while position < len(payload):
        if payload[position:position + 1] == b"\n":
            position += 1
            continue
        header = re.match(rb"([0-9a-f]+):", payload[position:])
        if not header:
            end = payload.find(b"\n", position)
            position = end + 1 if end >= 0 else len(payload)
            continue
        identifier = header[1].decode("ascii")
        body_start = position + header.end()
        text_header = re.match(rb"T([0-9a-f]+),", payload[body_start:])
        if text_header:
            start = body_start + text_header.end()
            end = start + int(text_header[1], 16)
            if end > len(payload):
                raise ValueError("Incomplete public Flight text record")
            texts[identifier] = payload[start:end].decode("utf-8")
            position = end
            continue
        end = payload.find(b"\n", body_start)
        end = end if end >= 0 else len(payload)
        body = payload[body_start:end].decode("utf-8")
        models.append(body)
        try:
            outlined[identifier] = json.loads(body)
        except ValueError:
            pass  # Module imports, hints and other non-model Flight records.
        position = end + 1
    return "\n".join(models), texts, outlined


def _resolve_flight(value, texts, outlined, resolving=None):
    if isinstance(value, dict):
        return {key: _resolve_flight(item, texts, outlined, resolving) for key, item in value.items()}
    if isinstance(value, list):
        return [_resolve_flight(item, texts, outlined, resolving) for item in value]
    if not isinstance(value, str):
        return value
    if value.startswith("$$"):
        return value[1:]  # Flight escapes a literal leading dollar sign.
    if re.fullmatch(r"\$[0-9a-f]+", value):
        identifier = value[1:]
        if identifier in texts:
            return texts[identifier]
        resolving = set(resolving or ())
        if identifier in resolving:
            raise ValueError("Circular public Flight reference")
        if identifier in outlined:
            return _resolve_flight(outlined[identifier], texts, outlined, resolving | {identifier})
        raise ValueError("Unresolved public Flight reference: " + value)
    if value.startswith("$D") and _date(value) is not None:
        return value[2:]
    return value


def extract_pack(document, expected_id=None):
    """Select the complete requested pack, ignoring the site's random question."""
    source, texts, outlined = _flight_records(extract_next(document))
    matches = []
    for match in re.finditer(r'"pack"\s*:\s*\{', source):
        value, _ = json.JSONDecoder().raw_decode(source, match.end() - 1)
        if isinstance(value, dict) and isinstance(value.get("tours"), list):
            if expected_id is None or value.get("id") == expected_id:
                matches.append(value)
    if not matches:
        raise ValueError("Complete published pack not found")
    ids = {pack.get("id") for pack in matches}
    if len(ids) != 1:
        raise ValueError("Ambiguous public pack response")
    return _resolve_flight(matches[0], texts, outlined)


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignore = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe", "object"}:
            self.ignore += 1
        elif not self.ignore and (tag == "br" or tag in BLOCKS):
            self.parts.append("\n")
            if tag == "li":
                self.parts.append("• ")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe", "object"}:
            self.ignore = max(0, self.ignore - 1)
        elif not self.ignore and tag in BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.ignore:
            self.parts.append(data)


def plain_text(value):
    """Convert optional markup to inert text, preserving lists and paragraphs."""
    if not isinstance(value, str):
        return ""
    # The publisher's records use both actual and literal backslash-newlines.
    value = value.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    parser = _PlainText()
    parser.feed(value)
    parser.close()
    text = unescape("".join(parser.parts)).replace("\xa0", " ")
    text = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _number(value, lower=None, upper=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if lower is not None and value < lower or upper is not None and value > upper:
        return None
    return value


def _public_url(value):
    if not isinstance(value, str) or not value.strip():
        return None
    url = urljoin(GQ + "/", unescape(value.strip()))
    parsed = urlparse(url)
    return url if parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.username and not parsed.password else None


def _person(credit):
    if not isinstance(credit, dict):
        return None
    person = credit.get("person") if isinstance(credit.get("person"), dict) else credit
    name = plain_text(person.get("name"))
    identifier = person.get("id", credit.get("personId"))
    if not name or not isinstance(identifier, int) or isinstance(identifier, bool) or identifier <= 0:
        return None
    result = {"id": "gq-person-" + str(identifier), "name": name,
              "sourceUrl": GQ + "/person/" + str(identifier), "gotQuestionsPersonId": identifier,
              "identitySource": "gotquestions_published_person"}
    for field in ("surname", "lastName"):
        if isinstance(person.get(field), str) and person[field].strip():
            result[field] = plain_text(person[field])
    for field in ("playerId", "copyrightId"):
        if person.get(field) is not None:
            result[field] = person[field]
    if credit.get("alias"):
        result["creditedAs"] = plain_text(credit["alias"])
    return result


def _people(credits):
    people = {}
    for credit in credits if isinstance(credits, list) else []:
        person = _person(credit)
        if person:
            people.setdefault(person["id"], person)
    return list(people.values())


def _media(question):
    result = []
    seen = set()
    fields = [("razdatkaPic", "image", "handout"), ("razdatkaPicGeneric", "image", "handout"),
              ("audio", "audio", "question"), ("answerPic", "image", "answer"),
              ("commentPic", "image", "comment"), ("commentAudio", "audio", "comment")]
    for field, kind, role in fields:
        value = question.get(field)
        if not value:
            continue
        url = _public_url(value)
        if url and (url, role) not in seen:
            seen.add((url, role))
            result.append({"type": kind, "url": url, "role": role, "sourceField": field})
    # Some published older records also contain inline image/media markup.
    for field, role in [("text", "question"), ("razdatkaText", "handout"), ("answer", "answer"), ("comment", "comment")]:
        value = question.get(field, "")
        if not isinstance(value, str):
            continue
        for match in re.finditer(r'<(img|audio|video)\b[^>]*\bsrc\s*=\s*[\"\']([^\"\']+)[\"\']', value, re.I):
            url = _public_url(match[2])
            if url and (url, role) not in seen:
                seen.add((url, role))
                result.append({"type": "image" if match[1].lower() == "img" else match[1].lower(), "url": url,
                               "role": role, "sourceField": field})
    return result


def _date(value):
    if not isinstance(value, str):
        return None
    value = value.removeprefix("$D")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def _timestamp(value):
    return value.removeprefix("$D") if isinstance(value, str) else None


def normalize_pack(pack, window_start=None, window_end=None, fetched_at=None):
    """Keep every published question and explicitly mark unavailable metadata.

    `trueDl` is one official observation: the linked tournament with the most
    teams. All observations remain in `officialDifficulties`; no mean is invented.
    This function never removes media, repeated text, played or unusual questions.
    The caller handles catalog completeness and date-window membership.
    """
    from question_types import classify
    identifier = pack.get("id")
    if not isinstance(identifier, int) or isinstance(identifier, bool) or identifier <= 0:
        raise ValueError("Pack ID must be a positive integer")
    if not isinstance(pack.get("tours"), list):
        raise ValueError("Pack tours must be present")
    url = GQ + "/pack/" + str(identifier)
    observations = []
    difficulties = pack.get("truedls") if isinstance(pack.get("truedls"), list) else []
    tournaments = pack.get("tIds") if isinstance(pack.get("tIds"), list) else []
    teams = pack.get("teams") if isinstance(pack.get("teams"), list) else []
    for index, value in enumerate(difficulties):
        value = _number(value, 0, 10)
        if value is None:
            continue
        observations.append({"trueDl": value, "tournamentId": tournaments[index] if index < len(tournaments) else None,
                             "teams": _number(teams[index], 0) if index < len(teams) else None})
    primary = max(observations, key=lambda row: row["teams"] if row["teams"] is not None else -1) if observations else None
    day = _date(pack.get("startDate"))
    in_window = None
    if window_start and window_end and day:
        in_window = str(window_start)[:10] <= day <= str(window_end)[:10]
    package = {"id": identifier, "name": plain_text(pack.get("title")), "url": url, "sourceUrl": url,
               "dateStart": _timestamp(pack.get("startDate")), "dateEnd": _timestamp(pack.get("endDate")),
               "publishedAt": _timestamp(pack.get("pubDate")),
               "type": pack.get("type"), "trueDl": primary["trueDl"] if primary else None,
               "trueDlValues": [row["trueDl"] for row in observations], "officialDifficulties": observations,
               "difficultyScope": "package", "difficultySelection": "most_teams_tournament" if primary else "not_available",
               "difficultySourceUrl": url, "difficultyCheckedAt": fetched_at, "fetchedAt": fetched_at,
               "ratingTournamentId": primary["tournamentId"] if primary else None,
               "ratingTournamentIds": tournaments, "sourcePrecision": "exact_published_record",
               "editors": _people(pack.get("editors")), "published": pack.get("published"),
               "adultOnly": bool(pack.get("adultOnly")), "info": plain_text(pack.get("info")),
               "inRequestedDateWindow": in_window}
    questions = []
    seen = set()
    for tour in pack["tours"]:
        if not isinstance(tour, dict) or not isinstance(tour.get("questions"), list):
            raise ValueError("Every published tour must include its question array")
        for question in tour["questions"]:
            qid = question.get("id")
            if not isinstance(qid, int) or isinstance(qid, bool) or qid <= 0 or qid in seen:
                raise ValueError("Question IDs must be positive and unique in the pack")
            seen.add(qid)
            main = plain_text(question.get("text"))
            handout = plain_text(question.get("razdatkaText"))
            text = "\n\n".join(part for part in [handout, main] if part) if handout != main else main
            media = _media(question)
            missing_text = not bool(text)
            if missing_text and media:
                text = "Вопрос содержит приложение."
            authors = _people(question.get("authors"))
            answer = plain_text(question.get("answer"))
            # These arrays are parallel observations in the published packet.
            # Never derive a question's difficulty from the packet trueDL or
            # reconstruct a missing denominator from a rounded percentage.
            correct = question.get("correctAnswers")
            counts = question.get("teamsCount")
            question_observations = []
            if isinstance(correct, list) and isinstance(counts, list) and len(correct) == len(counts):
                for index, (successes, count) in enumerate(zip(correct, counts)):
                    successes = _number(successes, 0)
                    count = _number(count, 1)
                    if (successes is None or count is None or int(successes) != successes
                            or int(count) != count or successes > count):
                        continue
                    question_observations.append({"sourceIndex": index,
                        "tournamentId": tournaments[index] if len(tournaments) == len(counts) and type(tournaments[index]) is int and tournaments[index] > 0 else None,
                        "correctAnswers": successes, "teamsCount": count, "rate": successes / count,
                        "trueDl": _number(difficulties[index], 0, 10) if len(difficulties) == len(counts) else None})
            category = classify(question)
            questions.append({"id": "gq-pack-" + str(identifier) + "-question-" + str(qid),
                              "canonicalQuestionId": qid, "number": question.get("number"),
                              "printedNumber": question.get("number"), "ordinal": len(questions) + 1,
                              "text": text, "mainText": main, "handoutText": handout, "answer": answer,
                              "acceptedAnswers": [], "acceptedText": plain_text(question.get("zachet")),
                              "rejectedText": plain_text(question.get("nezachet")), "comment": plain_text(question.get("comment")),
                              "sources": plain_text(question.get("source")), "note": plain_text(question.get("note")),
                              "form": plain_text(question.get("form")), "authors": authors, "package": package,
                              "classification": {key: category[key] for key in ("handout", "format", "forms")},
                              "difficultyObservations": question_observations,
                              "sourceUrl": GQ + "/question/" + str(qid), "media": media,
                              "tour": plain_text(tour.get("title")) or "Тур " + str(tour.get("number", "")),
                              "tourId": tour.get("id"), "tourNumber": tour.get("number"),
                              "flags": {"nonstandardTiming": bool(NONSTANDARD.search(text)), "missingAnswer": not bool(answer),
                                        "missingAuthors": not bool(authors), "missingQuestionText": missing_text,
                                        "missingDifficulty": primary is None, "takenDown": bool(question.get("takenDown")),
                                        "hasControversials": bool(question.get("hasControversials")),
                                        "hasAppeals": bool(question.get("hasAppeals")), "marked": bool(question.get("marked")),
                                        "hasMedia": bool(media), "hasHandout": bool(handout or question.get("razdatkaPic"))},
                              "publishedStatistics": {"correctAnswers": question.get("correctAnswers", []),
                                                      "complexity": question.get("complexity", []),
                                                      "teamsCount": question.get("teamsCount", [])},
                              "provenance": {"textProvider": "gotquestions_public_pack_page", "textSourceUrl": url,
                                             "fetchedAt": fetched_at, "gotQuestionsQuestionId": qid,
                                             "gotQuestionsIdPacketMembershipVerified": True,
                                             "mappingMethod": "published_question_in_pack_record"}})
    package["questions"] = len(questions)
    package["sourceQuestionCount"] = len(questions)
    return {"package": package, "questions": questions}
