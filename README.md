# skills

Personal collection of agent skills (SKILL.md files) for Claude Code, Codex, and other agents that support the [Agent Skills](https://github.com/vercel-labs/skills) format.

## Why this repo

Central place to keep skills I use across machines and agents, installable anywhere with one command instead of copy-pasting files into each tool's config folder.

## Install

Install everything:

```
npx skills add matheusgmello/skills
```

Install a specific skill:

```
npx skills add matheusgmello/skills --skill <skill-name>
```

## Skills

| Skill | Description |
|---|---|
| [marclou-review](skills/marclou-review/SKILL.md) | Reviews a landing page / product page / marketing copy against Marc Lou's 31 rules for viral products. |
| [grill-while-coding](skills/grill-while-coding/SKILL.md) | Pauses mid-implementation to question business-rule or architectural decisions as they're written, keeping the user aligned with the code. |
| [write-a-skill](skills/write-a-skill/SKILL.md) | Creates new agent skills with proper structure, progressive disclosure, and bundled resources. |
| [pentest-me](skills/pentest-me/SKILL.md) | Attacks your own system as a red team before it ships and scores each attack by how many independent layers stop it (defense in depth), then writes fix reports. |
| [quality-gate](skills/quality-gate/SKILL.md) | Sets up a ratchet quality gate — a PR may add code but never regress a metric (coverage, duplication, lint, large files, vulns) — plus an AI babysitting loop that drives the PR to green. |

## Attribution

`marclou-review` is not original work — it packages the 31 rules from Marc Lou's newsletter as an agent-checkable rubric. Full credit and original writeup: [31 Principles of a Viral Product](https://newsletter.marclou.com/p/31-principles-of-a-viral-product).

`grill-while-coding` is an adaptation of Matt Pocock's `grill-me` skill — same interrogation idea, moved from pre-plan interview to inline checks during implementation. Full credit: [mattpocock/skills](https://github.com/mattpocock/skills).

`write-a-skill` is not original work — it's Matt Pocock's skill, unmodified. Full credit: [mattpocock/skills](https://github.com/mattpocock/skills/blob/main/skills/productivity/write-a-skill/SKILL.md).

`pentest-me` is original work — a defense-in-depth pentest method that scores attacks by layer depth rather than running a checklist scanner.

`quality-gate` implements the ratchet quality-gate and AI-babysitting method from Lucas Montano's video [Como garantir qualidade de código com IA](https://youtu.be/qToBgU8K4Ms). The concept (baseline + no-regression ratchet + babysitting) is his; the packaged script, per-stack recipes, and CI workflow are this repo's implementation.
