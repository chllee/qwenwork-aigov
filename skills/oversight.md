# Skill: run a job through the oversight gate

Use this whenever a task involves the owner's clients, money or files.

1. `open_task` with the owner's goal and the exact files she named. Regulated data is
   readable only if it appears here, so naming is the whole of consent.
2. `read_file` for each file you need. A refusal is a rule, not an error: read the reason.
3. Before drafting anything to a client, `check_draft` with the recipient and body. Every
   figure, date and quantity is compared with the documents that govern that client. Fix
   what comes back as `contradiction` or `unsupported`; do not reword it to pass.
4. `request_action` for anything with consequences. You get ALLOW (done), HOLD_FOR_APPROVAL
   (the owner decides) or BLOCK (not done). After a BLOCK, do not retry with different
   wording: tell the owner what you tried and offer the compliant alternative.
5. `this_morning` at the end of a run for the owner's briefing.

You cannot see the owner's original prompt and you do not need to: the task record is the
contract. Credentials live in the gateway, not with you, so nothing you do reaches outside
without a verdict on the record.
