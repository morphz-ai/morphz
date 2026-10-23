"""CLI request fixtures; no network, model or official game performance claim."""
import json
import unittest

from arc_cli import build_request


class CliTests(unittest.TestCase):
    def test_observe_is_read_only(self):
        request = build_request(1234, ['observe'])
        self.assertEqual(request.full_url, 'http://127.0.0.1:1234/observe')
        self.assertEqual(request.get_method(), 'GET')
        self.assertIsNone(request.data)

    def test_step_is_one_action_with_a_fresh_observation(self):
        request = build_request(1234, ['step', 'ACTION6', '12', '30'])
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(json.loads(request.data), {
            'action': 'ACTION6', 'data': {'x': 12, 'y': 30}, 'with_observation': True})

    def test_baseline_interface_is_unchanged(self):
        self.assertEqual(build_request(1234, []).full_url, 'http://127.0.0.1:1234/status')
        self.assertEqual(json.loads(build_request(1234, ['action', 'ACTION1']).data),
                         {'action': 'ACTION1'})
        self.assertEqual(json.loads(build_request(1234, ['batch', '[{"action":"ACTION1"}]']).data),
                         {'actions': [{'action': 'ACTION1'}]})

    def test_malformed_commands_are_not_submitted(self):
        for args in (['status', 'extra'], ['observe', 'extra'], ['step'],
                     ['step', 'ACTION6', '4'], ['batch', 'not json']):
            with self.assertRaises(ValueError):
                build_request(1234, args)


if __name__ == '__main__':
    unittest.main()
