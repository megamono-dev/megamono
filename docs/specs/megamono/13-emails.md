---
id: spec-megamono-0013
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, email, testing, playstack]
summary: Defines the typed email-library generator, local preview, seed templates, send-time rendering, and compatibility checks.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0003,
    spec-megamono-0006,
    spec-megamono-0007,
  ]
external_references:
  [
    playstack:02-auth,
    playstack:03-accounts,
    playstack:05-provider-abstractions,
    playstack:21-notifications,
    playstack:23-mfa,
    playstack:25-billing,
    playstack:27-validation,
    playstack:39-i18n,
  ]
---

# 13 — Email Library Generator

> **Cross-corpus dependency.** `playstack:05-provider-abstractions` and `playstack:21-notifications` now accept code-rendered delivery as the default while retaining provider-native templates. The generator remains gated until those packages publish the compatible fixtures required by `spec-megamono-0000`; the architecture decision itself is no longer unresolved.

## What it does

`npm exec nx g @megamono/plugin:emails --project=emails` scaffolds `libs/emails` — a Chakra-based email library, its Nx targets, a preview surface, and a seed set of the transactional templates every product needs.

## Why the reversal

Provider-native templates have real advantages: preview, versioning, and non-developer editing, with no rendering to own.

They have one disadvantage that outweighs those:

> **A provider template takes an untyped model. A mismatch fails silently at send time.**

Send `{ userName }` to a template expecting `{ name }` and the email goes out with a blank greeting. Nothing errors, nothing logs, and the failure surfaces as a customer screenshot. Given `playstack:27-validation` establishes typed contracts everywhere else in the stack, leaving the one artifact customers actually read untyped is inconsistent.

Code templates also give version control and review, testability, portability across providers, and — via `chakra.email` — the same design tokens as the app.

### The resolution keeps the mail abstraction

**Render in code; deliver via provider.** Templates compile to HTML, and the rendered HTML goes to Postmark rather than a template ID.

**Provider templates are not removed — they become one of three send modes** (`playstack:05-provider-abstractions`). Code templates are the default because they are the safer failure mode; `templateId` remains available and is the right choice for marketing email a non-developer edits in the provider's UI, or templates already living there that nobody is porting.

The cost of the default, stated: Postmark's preview and version history do not apply to code templates, because Postmark no longer holds them. That is what the preview surface below replaces.

**The hybrid needs both modes to exist.** Render at build time, push to Postmark via its template API, then send by `templateId`. Code stays the source of truth and the provider's features keep working, at the cost of a publish step and a sync that can drift. Recommended only where non-developers genuinely need to preview in Postmark — and it is only expressible because `templateId` was kept.

## Structure

```
libs/emails/
  src/
    components/     # shared — Button, Layout, Footer
    templates/      # one file per email, typed props
    theme.ts        # shared Chakra tokens
  preview/          # dev-only rendering surface
```

**Theme is shared with the app where one exists.** Email clients cannot use the same CSS, but tokens — colour, spacing, type scale — should come from one source, or the emails drift from the product's design within two releases.

## Seed templates

The generator emits the set every product needs, each mapped to an existing spec so they are not invented:

| Template                                      | Spec                         |
| --------------------------------------------- | ---------------------------- |
| Verify email, password reset, magic link      | `playstack:02-auth`          |
| Account invitation                            | `playstack:03-accounts`      |
| MFA enrolled, recovery codes regenerated      | `playstack:23-mfa`           |
| Receipt, payment failed, subscription changed | `playstack:25-billing`       |
| Notification digest                           | `playstack:21-notifications` |

Seeds are **starting points, not fixtures** — expected to be edited immediately. A generator emitting templates nobody changes has produced generic email.

**Each carries a typed props interface**, which is the point of the whole reversal.

## Preview

A dev-only surface rendering every template with sample props, hot-reloading on change.

This is the capability provider-native templates were giving up, and it has to be replaced or the reversal is a net loss. It is also the thing that makes editing templates tolerable — without it, iterating means sending yourself email.

Emitted as an Nx target: `npm exec nx run emails:preview`.

V1 colocates the preview under `libs/emails/preview` and serves it with Vite from a non-cacheable `preview` target. It is development-only, imports sample props from `preview/fixtures`, reads no production environment variables, and has no deploy target. A separately deployable stakeholder-preview app is deferred until a real consumer requires it.

## Plaintext is not optional

Every template needs a plaintext alternative. HTML-only mail is a **deliverability** problem, not only an accessibility one — spam filters weight multipart alternatives.

Generate a reasonable default from the rendered structure; allow the template module to export an explicit `renderText(props, locale)` override where the automatic version reads badly. **Do not let plaintext be forgotten**: the public render function always returns `{ html, text, subject }`, and missing or blank text fails tests.

## Testing and client compatibility

HTML email is a hostile rendering target — Outlook's Word engine, Gmail's CSS stripping, dark-mode inversion, and clipping past roughly 102KB.

What the generator can do:

- Emit tests asserting rendered output contains expected content, so a props rename breaks the build
- Emit a configurable encoded-HTML size check, with a conservative 100 KiB default limit
- **Document the constraints rather than solving them.** Litmus and Email on Acid do real client testing and are paid services; pretending otherwise would be worse than pointing at them.

## Boundary

|                                                   | Owner                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Generator, directory structure, Nx targets, seeds | **Megamono** (this)                                           |
| Email components, theme system, rendering         | **`chakra.email`** — the product                              |
| Delivery                                          | **`@playstack/mail`** (`playstack:05-provider-abstractions`)  |
| Fan-out and preferences                           | **`@playstack/notifications`** (`playstack:21-notifications`) |

`chakra.email` is canonical over `chakra-email.dev`, mirroring `react.email`'s positioning. This generator is a direct dogfood of it, and the templates it produces are exactly the "sawdust" the Chakra product family strategy anticipates — design artifacts from building the portfolio becoming sellable theme assets.

### Note on the emitted-packages table

`spec-megamono-0007` pins anything a generator emits by default to Playstack's Free tier. **`chakra.email` is a Commune product, not a Playstack package**, so that rule does not directly apply — but the underlying principle does: a scaffolded email library must render without a purchase. If `chakra.email` ever gains a paid tier, the generator must emit only its free surface.

## Generator contract

```text
npm exec nx g @megamono/plugin:emails \
  --project=emails \
  --directory=libs/emails \
  --theme-project=<optional-project> \
  --locales=en \
  --interactive=true \
  --dry-run
```

`--project`, `--directory`, and at least one locale are required in non-interactive mode. `--theme-project` is inferred only when exactly one `type:util`, `capability:theme-tokens` library exists; otherwise the generator emits an email-local token file. A supplied theme project must carry those tags, expose the documented platform-neutral token export, and may not import an application or either web theme system.

V1 renders at send time inside the queue worker. This supports recipient-specific props and the recipient's stored locale without a template publication step. Build-time publication to provider templates and hybrid synchronization are deferred; their drift and credential model need a separate accepted contract.

Every template module exports a typed props schema, subject function, and render function. Runtime input is parsed through the external validation contract before rendering. The library exports a discriminated `EmailRequest` union keyed by template name so the caller cannot pair one template with another template's props.

## V1 decisions

- Preview is colocated and local-only.
- Rendering is send-time only.
- Templates render per locale inside the queue worker using the recipient's stored locale. Catalogs use ICU MessageFormat and email strings have their own namespace, per `playstack:39-i18n`.
- Code-rendered mode is the accepted generator default. The generator remains excluded from the published collection only until the Playstack mail and notification fixture gate passes.

## Acceptance criteria

- The generated library typechecks, builds, previews all seeds, and renders deterministic `{ subject, html, text }` output for every locale fixture.
- Type tests prove that wrong or missing props fail compilation, and runtime tests prove invalid untyped input fails before delivery.
- Every seed has non-empty plaintext, stays within the configured encoded-size limit, and contains no production secret or recipient data in preview fixtures.
- The preview target binds to loopback by default, reads no production environment variables, is non-cacheable, and cannot deploy.
- Re-running the generator is a no-op; modified templates and theme files are never overwritten.
- The published generator gate fails until the external Playstack fixtures demonstrate code-rendered delivery and recipient-locale fan-out.
