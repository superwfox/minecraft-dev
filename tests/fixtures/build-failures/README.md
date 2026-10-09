# Build failure fixtures

`javac-missing-class.log` is the diagnostic excerpt from the actual build failure #452 requested in the remediation report. It retains the original source lines, diagnostic fields, and GitHub Actions timestamps; no credentials or workspace-specific absolute paths are present.

- Workflow run: https://github.com/superwfox/minecraft-dev-workflow/actions/runs/37817255305
- Job: `113448938578`
- Build checkout: `be102480e36ef915ef9f08a22de47d0c795b759e`

The other fixtures are synthetic representative javac/Maven logs for controlled method, constructor, multiple-symbol, and dependency regression scenarios. They are not excerpts from #452.
