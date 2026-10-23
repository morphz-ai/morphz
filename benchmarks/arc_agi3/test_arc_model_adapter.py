"""Transport fixtures, not real-model or ARC scores."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from arc_model_adapter import prepare_semantic_request, response_summary


class Projection(unittest.TestCase):
    def fixture(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        path=Path(directory.name)/'frame.png'
        path.write_bytes(b'\x89PNG\r\n\x1a\nfixture-not-a-rendered-game')
        request={'model':'fixture','stream':True,'max_completion_tokens':8192,
                 'tools':[],'messages':[{'role':'user','content':'Captured '+hashlib.sha256(path.read_bytes()).hexdigest()}]}
        return request,path

    def test_capture_bound_png_and_typed_policy_reach_actual_request(self):
        request,path=self.fixture()
        result,receipt=prepare_semantic_request(request,path)
        self.assertIsInstance(request['messages'][0]['content'],str)
        self.assertEqual(len(result['messages'][0]['content']),2)
        self.assertTrue(receipt['matched_runtime_capture'])
        self.assertFalse(result['chat_template_kwargs']['enable_thinking'])
        self.assertEqual(result['max_completion_tokens'],8192)
        self.assertEqual(result['response_format']['json_schema']['schema']['required'],['request'])
        again,second=prepare_semantic_request(result,path)
        self.assertEqual(again,result)
        self.assertFalse(second['image_added'])

    def test_no_uncaptured_image_or_tool_authority_expansion(self):
        request,path=self.fixture()
        for invalid in (dict(request,tools=[{'function':{'name':'exec'}}]),
                        dict(request,messages=[{'role':'user','content':'No attachment capture'}])):
            with self.assertRaises(ValueError):prepare_semantic_request(invalid,path)

    def test_whitespace_stop_is_empty_and_reasoning_is_not_an_answer(self):
        record={'status':200,'completed':True,'response':[{'choices':[{'delta':{
            'content':'\n\n','reasoning_content':'private fixture reasoning'},'finish_reason':'stop'}]}]}
        summary=response_summary(record)
        self.assertTrue(summary['empty_stop'])
        self.assertEqual(summary['visible_chars'],0)
        self.assertGreater(summary['reasoning_chars'],0)


if __name__=='__main__':unittest.main()
