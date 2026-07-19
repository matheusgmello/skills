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

## Attribution

`marclou-review` is not original work — it packages the 31 rules from Marc Lou's newsletter as an agent-checkable rubric. Full credit and original writeup: [31 Principles of a Viral Product](https://newsletter.marclou.com/p/31-principles-of-a-viral-product).
