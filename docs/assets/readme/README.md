# README icon assets

Icon paths are vendored from [Lucide](https://github.com/lucide-icons/lucide/tree/951813ce76a859d4d8b145366972cbb237147a4e/icons), pinned to commit `951813ce76a859d4d8b145366972cbb237147a4e`. Copyright and licensing terms (ISC, plus MIT for inherited Feather icons) are preserved in [LICENSE-lucide](LICENSE-lucide).

The upstream paths retain their 24 × 24 coordinate grid. CoNest adds a 48 × 48 colored tile, 12 px inset, 1.75 px stroke, round caps and round joins.

| Asset | Upstream icon |
| --- | --- |
| `connections.svg` | `waypoints` |
| `loops.svg` | `workflow` |
| `components.svg` | `blocks` |
| `memory.svg` | `database` |
| `studio.svg` | `panels-top-left` |
| `start.svg` | `terminal` |
| `branches.svg` | `git-branch` |
| `docs.svg` | `book-open` |
| `contribute.svg` | `code-xml` |
| `package.svg` | `package` |
| `lock.svg` | `lock-keyhole` |
| `archive.svg` | `archive` |

README layout uses native text headings and lists. Only the branch comparison uses a table. Avoid rasterizing branch names, versions or labels into custom badges.

## GitHub branch icon

`git-branch.svg` and `git-branch-dark.svg` preserve the official [GitHub Octicons `git-branch-16`](https://github.com/primer/octicons/blob/90af1f14984832de34e94b2d530043fbcf85eb7f/icons/git-branch-16.svg) path and 16 × 16 viewBox. Only the fill color is set for light/dark surfaces. The MIT license is included in [LICENSE-octicons](LICENSE-octicons).

Pinned upstream revision: `90af1f14984832de34e94b2d530043fbcf85eb7f`. The README uses this icon beside native linked `<code>` branch names. The previous custom colored branch badges have been removed.
