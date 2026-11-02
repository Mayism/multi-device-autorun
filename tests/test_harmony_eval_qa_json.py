"""JSON QA inputs keep references private and remain compatible with JSONL."""
import json
from pathlib import Path
import tempfile
import unittest

from harmonyeval.benchmarks.text_qa import TextDataset


class JsonQATest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='harmony-eval-qa-json-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.adapter = TextDataset()

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return path

    def test_array_normalizes_single_answer_and_preserves_public_boundary(self):
        path = self.write('cases.json', [{'id': 'q1', 'question': '问题', 'reference_answer': '标准答案',
            'criteria': ['正确'], 'metadata': {'topic': 'API'}}])
        case = self.adapter.load({'dir': str(path)})[0]
        self.assertEqual(case.expected['reference_answers'], ['标准答案'])
        self.assertEqual(case.public(), {'case_id': 'q1', 'question': '问题'})
        self.assertEqual(case.metadata['topic'], 'API')
        self.assertEqual(case.metadata['item_index'], 1)

    def test_cases_wrapper_and_existing_jsonl_can_be_loaded_together(self):
        self.write('cases.json', {'cases': [{'id': 'a', 'question': 'A', 'reference_answers': ['1', 'one']}]})
        (self.root / 'other.jsonl').write_text('\n' + json.dumps({'id': 'b', 'question': 'B',
                                                              'reference_answers': ['2']}) + '\n')
        cases = self.adapter.load({'dir': str(self.root)})
        self.assertEqual([c.case_id for c in cases], ['a', 'b'])
        self.assertEqual(cases[1].metadata['line'], 2)

    def test_invalid_cases_conflicting_answers_and_duplicate_ids_are_rejected(self):
        invalid = [
            {'question': 'missing id'},
            {'id': 'q', 'question': ''},
            {'id': 'q', 'question': 'Q', 'reference_answer': 1},
            {'id': 'q', 'question': 'Q', 'reference_answer': 'A', 'reference_answers': ['B']},
            {'id': 'q', 'question': 'Q', 'metadata': []},
        ]
        for raw in invalid:
            with self.subTest(raw=raw):
                path = self.write('invalid.json', [raw])
                with self.assertRaises(ValueError):
                    self.adapter.load({'dir': str(path)})
        path = self.write('duplicates.json', [{'id': 'q', 'question': 'one'}, {'id': 'q', 'question': 'two'}])
        with self.assertRaisesRegex(ValueError, '重复'):
            self.adapter.load({'dir': str(path)})

    def test_reference_changes_do_not_change_public_input_fingerprint(self):
        path = self.write('cases.json', [{'id': 'q', 'question': 'Q', 'reference_answer': 'A'}])
        first = self.adapter.load({'dir': str(path)})[0]
        self.write('cases.json', [{'id': 'q', 'question': 'Q', 'reference_answer': 'B'}])
        second = self.adapter.load({'dir': str(path)})[0]
        self.assertEqual(self.adapter.fingerprint(first), self.adapter.fingerprint(second))
        self.assertNotEqual(self.adapter.evidence_fingerprint(first), self.adapter.evidence_fingerprint(second))


if __name__ == '__main__':
    unittest.main()
