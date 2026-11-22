# Calibration decisions, and why

The classifier is tuned against `rules/ground_truth_labels.json`, and the tuning is
deliberate rather than fitted. Two judgement calls a judge might reasonably challenge:

**Own receiving details on an outbound invoice are internal, not regulated.**
`invoice_2026-031` prints a PayNow/UEN reference. The taxonomy lists "bank account
numbers" under regulated, but that data is the studio's own and is *addressed to the
client being billed*. Treating it as regulated would mean the layer blocks a normal
invoice. The rule applied: account identifiers belonging to the sender on a document
the sender issues to the named counterparty sit at internal. `finance/bank_details.md`
stays regulated because it aggregates card credentials, the owner's NRIC and PayNow in
one place — that is a credential store, not a payment footer.

**Mentioning patient data is not possessing it.** `contract_nimbus_health_2026.md`
includes a clause about not storing patient-identifiable data. The label is
client-confidential, not regulated: it describes an obligation. `inbox/2026-11-13`
includes an appointment export with columns and a sample row, so it is regulated.
The distinction the classifier draws is *containment vs description*, which is also the
distinction the PDPA draws.

**Publication consent outranks "a client is named".**
`marketing/case_study_harbourbean.md` names a client with figures and is public because
the client approved it for publication. The demotion only applies when no hard
identifier is present, so it cannot be used to launder a leak.
