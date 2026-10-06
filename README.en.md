# Project OS

**AI wrote more code. Did your product move forward?**

Project OS is a local desktop workbench for connecting a human goal with code-supported workflows, modules, development changes, check results and remaining gaps.

The launch kit includes a recorded self-case you can open without Node or Codex. Switch between actual analysis stages, filter relationships by goal, and inspect source references. This reader is separate from the full local workbench; it does not analyze your repository. Recorded model outputs remain in Chinese; English presentation headers and a narrated English video are available.

The same public Alpha.2 source was analyzed first without a human goal, then against prior user statements. More specific requirements changed the mappings and revealed additional missing evidence. The demonstrated development round changed the README entry point, not core product code. Its completion does not prove a core capability improvement.

For the actual workbench, use a supported Node version and your configured Codex CLI:

```sh
git clone https://github.com/rossky094-hub/project-os.git
cd project-os
npm ci
npm run build
npm run setup -- --source /path/to/your-project --scope src --evidence /path/to/selected-evidence --data /path/to/project-os-data --id my-project --label "My project"
npm start
```

Replace the placeholder paths. Source and evidence directories must be explicitly selected. The data directory must be outside both this package and the analyzed project. The service prints its actual loopback URL.

Setup and viewing do not call a model. Actual analysis sends registered source excerpts, goal statements and related state to your configured Codex service; review that scope before starting. The recorded case uses manual development-event imports. Independent beginner comprehension and reliable handling of unfamiliar projects remain unverified.

Desktop Alpha · MIT. [Repository](https://github.com/rossky094-hub/project-os) · [Current Alpha boundaries](https://github.com/rossky094-hub/project-os/blob/main/docs/ALPHA.md)
