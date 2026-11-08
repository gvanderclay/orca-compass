# Model data

OrcaCompass combines the data below with the models discovered from your
installed agents. The orchestrator supplies the task's difficulty; OrcaCompass
assigns models to tiers and uses live Orca usage to choose a route.

## The two data files

| File | Contents | Where users get updates |
| --- | --- | --- |
| `data/models-snapshot.json` | Model metadata from Models.dev: names, families, dates, prices and supported effort levels | Models.dev; the bundled file is the offline fallback |
| `data/modelindex-snapshot.json` | The Model Index capability scores and output prices | This file on the public OrcaCompass repository's `main` branch; the bundled copy is the offline fallback |

In the score file, `score` is the source's capability rating and `out` is the
output-token price in USD per million tokens. `date` is the model's date, not
the file's version. The top-level `fetchedAt` records when the maintainer
collected the snapshot. Source attribution and licenses are in
[NOTICE](https://github.com/manomilano/orca-compass/blob/main/NOTICE).

## Refresh timing

Downloaded metadata and scores are cached for 24 hours by default
(`modelsDevTtlHours`). The calculated tier table is reused for 5 hours
(`placementsTtlHours`). A table rebuild rediscovers local models and reads
the cached data; it only downloads data when its own cache has expired.
Checks run on demand when a command needs them, with no background polling.

The shorter table interval picks up changes in local agent catalogs while
reusing the daily data cache. A new model does not need to appear in either
downloaded dataset: its provider's description can supply its tier. For a
recognized versioned family, the newer release is preferred within that
agent and tier, such as Fable 5.5 over Fable 5.1. User overrides, bans and
usage limits still apply. The local catalog must actually list the model;
OrcaCompass cannot discover a release that the agent has not exposed yet.

A changed placement setting, a new CLI version, a newly detected agent or
`orcacompass refresh` can trigger an earlier rebuild. `refresh` also bypasses
the data-cache interval. Failed downloads use a valid cached copy, then the
bundled snapshot. Usage is read from Orca for each routing request.

Currently an expired data cache triggers a full download even if the remote
file has not changed. The stored retrieval times are not conditional-download
version checks. See [Tiers and routing](tiers-and-routing.md) for the calculation.

## Updating the shared scores

Maintainers can prepare updated data with:

```sh
npm run build
npm run snapshot -- scores
```

This maintainer command fetches The Model Index upstream and rewrites
`data/modelindex-snapshot.json`. Review the changed entries, run `npm test`
and `npm run test:package`, then submit the data update through the repository's
normal contribution process. Once it reaches `main`, installed clients that
support repository score fetching can receive it through their normal refresh
or immediately with `orcacompass refresh`. A data-only update needs no npm release.

Use `npm run snapshot -- models` to update the bundled Models.dev fallback,
or `npm run snapshot` for both files. Updated bundled fallbacks reach users
with the next npm release. Previous file versions remain in Git history.
