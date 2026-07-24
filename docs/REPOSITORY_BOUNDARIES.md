# Repository asset boundaries

MimiAgent separates product source from work created with the product.

## Product-owned

The main repository owns runtime source, tests, architecture and protocol documentation, release examples, evaluations, and the product Skills listed with `"status": "product"` in `skills/manifest.json`. Only those Skills may be included in the npm package.

`knowledge/mimi-agent.md` is product documentation used by the retrieval evaluation and is published by exact path. It is not a user Memory store.

## Incubating

Skills marked `"status": "experimental"` are source-only incubation assets. They are excluded from npm, carry no stable compatibility promise, and should move to a dedicated Skill incubator or their own repositories when independently maintained. Adding or promoting a Skill requires an explicit manifest change and review of its credentials, license, tests, and package impact.

## External workspace-owned

User projects, generated sites, screenshots, browser captures, private research notes, and runtime knowledge belong outside the product repository:

- standalone projects use their own repositories;
- disposable generation output uses an ignored `playground/` or another external workspace;
- personal knowledge is ingested into the user's private MimiAgent data root, normally `~/.mimi-agent`, and is never published;
- runtime databases, credentials, device identities, traces, and computer artifacts are always private state.

The existing `products/`, `projects/`, `web-articles/`, root media/demo files, non-product `knowledge/` files, and experimental Skills are legacy workspace assets pending extraction. They are frozen from product/package expansion; this change does not delete them because no external destination repository was supplied.

`npm run check:repo` validates that every checked-in Skill is classified, the four product Skills exactly match package publication, personal knowledge is not broadly included, and workspace project roots cannot enter the tarball.
