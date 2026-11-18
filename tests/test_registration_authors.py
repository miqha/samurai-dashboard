import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import fetch_registration_authors as R


class RegistrationAuthorsTest(unittest.TestCase):
    def inputs(self):
        a = {'id': 'gq-person-11', 'name': 'Анна Белова', 'playerId': 101}
        b = {'id': 'gq-person-12', 'name': 'Иван Ветров', 'playerId': 102}
        catalog = {'complete': True, 'teamHistoryVerified': True, 'teamId': 100321, 'teamTournamentIds': [2, 1, 3, 4], 'fetchedAt': 'fresh', 'tournaments': [
            {'id': 1, 'name': 'Будущий', 'gotQuestionsTags': [], 'editors': [{'id': 999, 'name': 'Другая подпись', 'gotQuestionsTag': 11}], 'difficultyForecast': 0},
            {'id': 2, 'name': 'Опубликованный', 'gotQuestionsTags': [70], 'editors': [{'id': 101, 'name': 'Анна Белова'}]},
            {'id': 3, 'name': 'Похожее название', 'gotQuestionsTags': [], 'editors': [{'id': 102, 'name': 'Любая подпись'}]},
            {'id': 4, 'name': 'Нет совпадений', 'editors': [{'id': 103, 'name': 'Белова'}]}
        ]}
        training = {'meta': {'complete': True, 'builtAt': 'training-new'}, 'packages': [{'id': 70, 'name': 'Похожее название', 'ratingTournamentIds': [2]}, {'id': 71, 'ratingTournamentIds': []}], 'questions': [
            {'id': 'target1', 'packageId': 70, 'authors': [b]},
            {'id': 'target2', 'packageId': 70, 'authors': []},
            {'id': 'old-a', 'packageId': 71, 'authors': [a]},
            {'id': 'old-b', 'packageId': 71, 'authors': [b]},
            {'id': 'unplayable', 'packageId': 71, 'authors': [a], 'flags': {'missingAnswer': True}}
        ]}
        history = {'team': {'id': 100321}, 'fetchedAt': 'history-new', 'tournaments': [{'id': 2, 'included': True, 'resultsAvailable': True}]}
        return catalog, training, history

    def test_exact_packet_credits_win_over_editor(self):
        b = R.build(*self.inputs())
        t = next(t for t in b['tournaments'] if t['tournamentId'] == 2)
        self.assertEqual(t['authorBasis'], 'question_credits')
        self.assertEqual([a['id'] for a in t['authors']], ['gq-person-12'])
        self.assertEqual(t['authors'][0]['questions'], 1, 'Target packet questions cannot count as previous practice')
        self.assertEqual(t['targetQuestionsWithAuthors'], 1)
        self.assertEqual(t['publishedTargetQuestions'], 2)
        self.assertEqual(t['targetPackageIds'], ['70'])
        self.assertTrue(t['teamResultsAvailable'])

    def test_unpublished_fallback_is_explicit_and_id_based(self):
        b = R.build(*self.inputs())
        t = next(t for t in b['tournaments'] if t['tournamentId'] == 1)
        self.assertEqual(t['authorBasis'], 'rating_editors')
        self.assertEqual(t['authors'][0]['matchMethod'], 'official_gotquestions_person_id')
        self.assertEqual(t['authors'][0]['questions'], 1, 'Missing source answers are excluded from candidate coverage')
        self.assertEqual(t['difficultyForecast'], 0)
        self.assertEqual(b['source']['trainingBuiltAt'], 'training-new')

    def test_no_title_or_surname_guess(self):
        rows = {t['tournamentId']: t for t in R.build(*self.inputs())['tournaments']}
        self.assertEqual(rows[3]['targetPackageIds'], [], 'Matching titles are not packet identity')
        self.assertEqual(rows[3]['authors'][0]['id'], 'gq-person-12', 'Published Rating player ID is sufficient')
        self.assertEqual(rows[4]['authors'], [])
        self.assertEqual(len(rows[4]['unmatchedAuthors']), 1)

    def test_ambiguous_exact_name_does_not_match(self):
        c, b, h = self.inputs()
        c['tournaments'][3]['editors'] = [{'name': 'Анна Белова'}]
        b['questions'].append({'id': 'same-name', 'packageId': 71, 'authors': [{'id': 'gq-person-99', 'name': 'Анна Белова'}]})
        t = next(t for t in R.build(c, b, h)['tournaments'] if t['tournamentId'] == 4)
        self.assertEqual(t['authors'], [])

    def test_new_registration_metadata_required(self):
        c, b, h = self.inputs()
        c['teamTournamentIds'].append(99)
        with self.assertRaisesRegex(ValueError, 'Missing tournament metadata'):
            R.build(c, b, h)
        c['teamHistoryVerified'] = False
        with self.assertRaisesRegex(ValueError, 'verified'):
            R.build(c, b, h)

    def test_refresh_hashes_and_javascript_match_current_inputs(self):
        c, b, h = self.inputs()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data/raw').mkdir(parents=True)
            for name, data in [('catalog', c), ('training', b), ('dashboard', h)]:
                (root / f'data/{name}.json').write_text(json.dumps(data), encoding='utf-8')
            result = R.refresh(root)
            for name, digest in result['source']['inputSha256'].items():
                self.assertEqual(digest, hashlib.sha256((root / name).read_bytes()).hexdigest())
            self.assertEqual(result, json.loads((root / 'data/registration-training.json').read_text()))
            js = (root / 'registration-training.js').read_text()
            self.assertEqual(result, json.loads(js.split('window.SAMURAI_REGISTRATION_TRAINING = ', 1)[1].rsplit(';', 1)[0]))
            self.assertEqual(len(result['tournaments']), 4)


if __name__ == '__main__':
    unittest.main()
