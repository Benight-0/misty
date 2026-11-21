import os
import unittest
from unittest.mock import patch

import misty


class PersonalMessageCLI(unittest.TestCase):
    def test_existing_dm_syntax_is_unchanged(self):
        with patch.dict(os.environ, {'MISTY_OWNER_MESSAGE_ID': 'owner-message'}):
            self.assertEqual(misty.request(['message-draft', 'room', 'exact text']),
                             ('message_draft', {'room': 'room', 'body': 'exact text', 'ownerMessageId': 'owner-message'}))

    def test_reply_and_read_only_inspect_preserve_arguments(self):
        op, args = misty.request(['message-draft', 'room', 'exact\nreply', '--reply-to', 'discord:123:456'])
        self.assertEqual(op, 'message_draft')
        self.assertEqual(args['replyTo'], 'discord:123:456')
        self.assertEqual(args['body'], 'exact\nreply')
        self.assertEqual(misty.request(['message-inspect', 'room', '--reply-to', 'message']),
                         ('message_inspect', {'room': 'room', 'replyTo': 'message'}))
        self.assertNotIn('ownerMessageId', misty.request(['message-inspect', 'room'])[1])

    def test_bad_or_extra_arguments_fail(self):
        for args in [[], ['room'], ['room', 'text', '--other', 'id'], ['room', 'text', '--reply-to'], ['room', 'text', '--reply-to', 'id', 'extra']]:
            with self.assertRaises(ValueError):
                misty.request(['message-draft', *args])


if __name__ == '__main__':
    unittest.main()
