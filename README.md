# Software Factory

A self-improving AI software factory: it turns GitHub issues into verified,
reviewed, integration-ready pull requests, and gets measurably better over time.

```
issues → triage → worker → verifier → reviewer → integrator → draft PR → human merges
                                 ▲                                      │
                                 └──── benchmark-gated self-improvement ┘
```

The project is built spec-first. Start with [`specs/00-overview.md`](./specs/00-overview.md);
progress is tracked in [`specs/STATUS.md`](./specs/STATUS.md).

| Phase | Spec |
|-------|------|
| 0 | [Foundations](./specs/01-foundations.md) |
| 1 | [Benchmark](./specs/02-benchmark.md) |
| 2 | [Sandboxes](./specs/03-sandboxes.md) |
| 3 | [Intake & claims](./specs/04-intake-and-claims.md) |
| 4 | [Single-issue pipeline](./specs/05-single-issue-pipeline.md) |
| 5 | [Parallel & integration](./specs/06-parallel-and-integration.md) |
| 6 | [Self-improvement](./specs/07-self-improvement.md) |
| 7 | [Team readiness](./specs/08-team-readiness.md) |

Architecture reference: "How to Build a Self-Improving AI Software Factory That
Actually Ships" (Prompt Engineering, YouTube).
