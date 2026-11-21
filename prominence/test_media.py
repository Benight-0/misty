import ast
import io
from pathlib import Path
import socket
import tempfile
import types
import unittest
from unittest.mock import patch

from PIL import Image

import config
import message_media
import misty
import misty_media as media


class MediaTests(unittest.TestCase):
    def test_urls_keep_signatures_and_balance_markdown(self):
        self.assertEqual(media.urls_in('[picture](https://example.com/a_(b).png?ex=1&hm=2&) https://example.com/a_(b).png?ex=1&hm=2&'),
                         ['https://example.com/a_(b).png?ex=1&hm=2&'])

    def test_helper_commands_stay_local(self):
        self.assertEqual(misty.request(['media', 'source', '1']), ('local_media', {'id': 'source', 'index': 1}))
        self.assertEqual(misty.request(['open', 'https://example.com']), ('local_open', {'url': 'https://example.com'}))

    def test_private_urls_and_mixed_dns_are_rejected(self):
        for url in ('file:///etc/passwd', 'https://user:pass@example.com'):
            with self.assertRaises(ValueError):
                media.public_url(url)
        for addresses in (['127.0.0.1'], ['203.0.113.10'], ['203.0.113.10', '203.0.113.10'], ['::1']):
            dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443)) for address in addresses]
            with patch.object(media.socket, 'getaddrinfo', return_value=dns), self.assertRaises(ValueError):
                media.public_url('https://example.com/image.png')

    def test_redirect_is_checked_before_fetch(self):
        with patch.object(media, 'public_url', side_effect=ValueError('private')) as validate, self.assertRaises(ValueError):
            media.PublicRedirect().redirect_request(None, None, 302, '', {}, 'http://127.0.0.1/')
        validate.assert_called_once_with('http://127.0.0.1/')

    def test_page_text_drops_scripts_and_marks_preview_unseen(self):
        html = b'<title>test</title><meta property="og:image" content="/preview.png"><p>actual content</p><script>hidden</script>'
        with patch.object(media, 'download', return_value=(html, 'text/html', 'utf-8', 'https://example.com/page')):
            result = media.open_url('https://example.com/page')
        self.assertTrue(result['ok'])
        self.assertIn('actual content', result['text'])
        self.assertNotIn('hidden', result['text'])
        self.assertEqual(result['previewImages'], ['https://example.com/preview.png'])
        self.assertIn('not been viewed', result['coverage'])

    def test_image_and_animation_are_real_local_files(self):
        stream = io.BytesIO()
        frames = [Image.new('RGB', (10, 10), color) for color in ('red', 'green', 'blue')]
        frames[0].save(stream, 'GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
        with tempfile.TemporaryDirectory() as temp, patch.object(config, 'DATA_DIR', temp):
            result = media.image_files(stream.getvalue(), 'https://example.com/a.gif')
            self.assertEqual(result['frames'], [0, 1, 2])
            self.assertEqual(result['totalFrames'], 3)
            for path in result['paths']:
                with Image.open(path) as image:
                    self.assertEqual(image.size, (10, 10))

    def test_download_failure_is_not_empty_success(self):
        with patch.object(media, 'download', side_effect=OSError('gone')):
            result = media.open_url('https://example.com/image.png')
        self.assertFalse(result['ok'])
        self.assertIn('not been seen', result['error'])

    def test_unavailable_source_never_downloads(self):
        with patch.object(media, 'open_url') as fetch:
            result = media.source_media('missing', lambda *args: {'available': False})
        self.assertFalse(result['available'])
        fetch.assert_not_called()

    def test_paging_keeps_source_hash_and_url_index(self):
        base = {'available': True, 'id': 'original', 'url': 'https://example.com/source', 'bodyHash': 'hash'}
        def call(op, args):
            if args['args'].get('offset'):
                return {**base, 'body': 'https://example.com/b', 'nextOffset': None}
            return {**base, 'body': 'https://example.com/a\n', 'nextOffset': 22}
        with patch.object(media, 'open_url', return_value={'ok': True}) as fetch:
            result = media.source_media('original', call, 1)
        fetch.assert_called_once_with('https://example.com/b')
        self.assertEqual(result['items'][0]['index'], 1)
        self.assertEqual(result['bodyHash'], 'hash')
        with self.assertRaises(ValueError):
            media.source_media('original', call, 7)

    def test_source_edit_during_paging_rejected(self):
        responses = iter([{'available': True, 'body': 'first', 'nextOffset': 5, 'bodyHash': 'old'},
                          {'available': True, 'body': 'second', 'nextOffset': None, 'bodyHash': 'new'}])
        with self.assertRaises(ValueError):
            media.source_media('source', lambda *args: next(responses))

    def test_post_video_is_labelled_thumbnail_only(self):
        tweet = {'code': 200, 'tweet': {'text': 'post', 'media': {'all': [{'type': 'gif', 'url': 'https://example.com/video.mp4', 'thumbnail_url': 'https://example.com/thumb.jpg'}]}}}
        import json
        with patch.object(media, 'download', return_value=(json.dumps(tweet).encode(), '', '', '')), patch.object(media, 'open_url', return_value={'ok': True}):
            result = media.read_tweet('https://x.com/u/status/123', 'https://api.fxtwitter.com/status/123')
        self.assertEqual(result['provider'], 'FxTwitter public mirror')
        self.assertIn('has not been watched', result['media'][0]['coverage'])

    def test_owner_prompt_keeps_failed_images_embeds_and_reply(self):
        # Execute only the pure formatter, never import/start the running bot.
        tree = ast.parse(Path(__file__).with_name('bot.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'dm_text')
        scope = {'config': types.SimpleNamespace(AGENT_BACKEND='codex'), 'BOT_ID': 'bot',
                 'message_media': message_media, 'images_in': lambda messages: []}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'dm_text', 'exec'), scope)
        message = {'id': 'now', 'attachments': [{'url': 'https://example.com/expired.png'}],
                   'embeds': [{'title': 'context', 'image': {'url': 'https://example.com/embed.jpg'}}],
                   'referenced_message': {'id': 'old', 'author': {'id': 'owner'}, 'attachments': [{'url': 'https://example.com/reply.png'}]}}
        text = scope['dm_text'](message, images=True)
        for expected in ('expired.png', 'embed.jpg', 'reply.png', 'context'):
            self.assertIn(expected, text)
        scope['images_in'] = lambda messages: ['/tmp/visible.png']
        self.assertIn('open it with view_image', scope['dm_text'](message, images=True))


if __name__ == '__main__':
    unittest.main()
