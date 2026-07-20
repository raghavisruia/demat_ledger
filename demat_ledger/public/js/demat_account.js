frappe.ui.form.on("Demat Account", {
	setup(frm) {
		frm.set_query("account", () => ({
			filters: {
				company: frm.doc.company,
				is_group: 0,
			},
		}));
	},
	company(frm) {
		// The previously selected ledger may belong to a different company - clear it
		// rather than leaving a mismatched combination.
		if (frm.doc.account) {
			frm.set_value("account", "");
		}
	},
});
