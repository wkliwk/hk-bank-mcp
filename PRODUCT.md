# hkma-mcp — Product Definition

## Overview

**What it is:** An MCP (Model Context Protocol) server that gives any AI assistant — Claude Code, Claude Desktop, or any MCP client — accurate, live knowledge from the **official Hong Kong Monetary Authority (HKMA) public API**.

**Who it's for:** People living in Hong Kong who want to ask an AI assistant practical banking questions in plain Cantonese or English, and get answers grounded in official data rather than a model's stale training memory.

**The problem it solves:** Ask an LLM "3個月HIBOR而家幾多?" today and it will either refuse or hallucinate a rate from 2023. The data exists — HKMA publishes an open API with no key required — but nothing connects it to an AI assistant. This project is that connection.

**Why it is not a wrapper:** Tools are designed around what a person asks, not around what an endpoint returns. Six HKMA locator endpoints collapse into one `hk_find_bank_location` tool. Tool descriptions, response shapes and token cost are iterated against an eval suite, not guessed.

**Scope, stated explicitly (decided 2026-09-25):** This project covers HKMA's own public API only — the regulator's data, not any individual bank's. Comparing products across banks' own Open Banking APIs (HSBC, Hang Seng, BOCHK, Standard Chartered's Phase I product feeds) is a **separate, not-yet-started project** with its own name and repo. The two were split rather than combined because they are genuinely different data sources with different owners, different terms of use, and different reliability profiles — a name and a scope that describe both honestly would have to keep growing every time either half changed, and `hkma-mcp` would stop being an accurate name the moment it also read a bank's own API. See [Design decisions](#design-decisions) for the full reasoning.

## Principles

1. **Public data only.** No bank credentials, no login automation, no scraping of authenticated sessions. Every data source is either HKMA's published open API or a file the user exported themselves.
2. **Consolidate by user intent.** Fewer, richer tools beat one tool per endpoint. Per Anthropic's tool-design guidance, more tools do not mean better outcomes.
3. **High-signal responses.** Return names, rates, conditions and `as_of` dates. Never return internal IDs or hundreds of raw rows where a summary answers the question.
4. **Degrade gracefully.** One unreachable dataset must never fail the whole response — return the rest and name what was unavailable.
5. **Never mislead about money.** A headline rate with hidden conditions is worse than no answer. Conditions, caps and effective dates are first-class fields, and published rates are labelled indicative, not an offer.

## Versions

Shipped incrementally — each version is independently installable and useful.

| Version | Theme | Milestone |
|---|---|---|
| v0.1 | HKMA Core — locations + interest rates | [v0.1](https://github.com/wkliwk/hkma-mcp/milestone/1) |
| v0.2 | HKMA Complete — legitimacy checker, contacts, evals | [v0.2](https://github.com/wkliwk/hkma-mcp/milestone/2) |
| — | Further HKMA data sources (macro statistics, deposit/loan aggregates — see the API survey below) and any local file analysis: undecided | — |

## Features

### 1. Bank location finder — `hk_find_bank_location` (v0.1)

**Description:** Find ATMs, branches and self-service banking facilities across Hong Kong, filtered by district, bank and service type.

**User flow:** User asks "邊度有恒生分行喺沙田?" → Claude calls the tool with district and fuzzy bank name → returns branches with addresses, services and hours.

**Acceptance criteria:**
- One tool covers ATM, branch and self-service via a `type` parameter
- Bank name matching accepts English and Chinese, and common short forms
- Results capped with a stated total match count
- Unknown district or bank returns valid values, not an empty array

### 2. Interest rates — `hk_get_interest_rates` (v0.1)

**Description:** HIBOR and HKD reference rates, latest figure or historical range with trend summarisation.

**User flow:** User asks "3個月HIBOR而家幾多?" → tool returns the latest figure with its `as_of` date. Asking for a range returns latest/min/max/average/change instead of raw rows.

**Acceptance criteria:**
- Defaults to latest value when no date range given
- Long ranges summarised, not dumped
- Every response carries `as_of` so a stale figure is never presented as today's

### 3. Server self-description — `hk_server_info` (v0.1)

**Description:** Reports the server version and which official data sources it reads, including how fresh each one is and what it cannot do.

**User flow:** The model calls it when it needs to explain where a figure came from, or to check what this server can answer before attempting a question.

**Acceptance criteria:**
- Reports server name and version
- Lists every configured data source with its publisher and measured freshness — not the freshness the publisher's own documentation claims
- States the no-credentials limitation explicitly, so the model can repeat it accurately if asked
- Carries `as_of`, consistent with every other tool

### 4. Bank legitimacy and scam checker — `hk_check_bank_legitimacy` (v0.2)

**Description:** Given a bank name, website or phone number, return whether it is an HKMA-authorised institution, a known published scam, or unknown.

**User flow:** User receives a suspicious SMS, asks "hsbc-hk-secure.com 係咪真係滙豐?" → tool normalises the domain, checks the HKMA register and fraudulent-sites list → returns a verdict with the source.

**Acceptance criteria:**
- Verdict is an explicit enum: `authorised` / `known_scam` / `not_found`
- `not_found` is never worded as "safe"
- Domain normalisation handles protocol, `www.`, paths and subdomains

### 5. Bank contacts — `hk_get_bank_contact` (v0.2)

**Description:** The right hotline for a purpose — lost card, account opening, verifying a caller who claims to be from your bank, SME lending, credit review.

**Acceptance criteria:**
- Purpose-driven parameter, not a raw hotline dump
- Ambiguous bank names return candidates rather than guessing

## Design decisions

Recorded here because the reasoning, not the code, is what distinguishes this project. Full detail lives in the issue each one links to.

| Decision | Why |
|---|---|
| Tools grouped by what a person asks, not by API endpoint ([#4](https://github.com/wkliwk/hkma-mcp/issues/4)) | HKMA publishes 15 bank-info endpoints organised by its own departments. None corresponds to a question anyone actually asks. A product API already designed around user intent — Trading212's, say — would deserve one tool per endpoint; this one does not. |
| Filtering happens server-side, not in the model ([#4](https://github.com/wkliwk/hkma-mcp/issues/4)) | The full ATM dataset is roughly 401,000 tokens against a 200,000-token context. Returning it raw is not a design preference, it is impossible. Filters are exposed as optional parameters so the model still decides what it wants. |
| Every filter parameter is optional, and responses state the total match count ([#4](https://github.com/wkliwk/hkma-mcp/issues/4)) | The server must never decide what the user wanted. Silently truncating is worse than refusing: a model that cannot see it is missing results will answer confidently and wrongly. |
| Stale data is served, clearly labelled, when the upstream fails ([#3](https://github.com/wkliwk/hkma-mcp/issues/3)) | The HKMA API intermittently returns HTTP 502 with an HTML body, or nothing at all. A figure marked 30 hours old beats an error. With nothing cached, the error tells the model to say so rather than recall a number from memory. |
| Bodies are parsed defensively rather than with `.json()` ([#3](https://github.com/wkliwk/hkma-mcp/issues/3)) | A 502 carries HTML. `SyntaxError: Unexpected token '<'` tells an agent nothing it can act on, which is exactly when a model invents a plausible interest rate. |
| Jev is used for scam impersonation detection ([#20](https://github.com/wkliwk/hkma-mcp/issues/20)) | Whether `hsbc-hk-secure.com` imitates a bank is a semantic judgement no string comparison makes. Its confidence score sets how strongly to warn, so the model is never blindly trusted. The lookup degrades to list matching if the service is unavailable. |
| Jev is deliberately NOT used for transaction categorisation ([#18](https://github.com/wkliwk/hkma-mcp/issues/18)) | It is a hosted API, and merchant names reveal where someone lives, works, and seeks medical care. If local statement analysis is ever built here, categorisation stays local for that reason — recorded now so the constraint is not forgotten if that work resumes. |
| This project covers HKMA's own API only; cross-bank comparison moved to a separate project ([#39](https://github.com/wkliwk/hkma-mcp/issues/39)) | Comparing deposit rates or credit cards across banks means reading each bank's own Open Banking API — a different data owner, different terms of use, different reliability. Combining that with HKMA's data in one server means the name and scope statement have to keep growing to cover both; splitting keeps each project's claim about itself exactly true. |

## Out of Scope

- **Individual banks' own APIs.** This project reads only HKMA's public API. Comparing products across HSBC, Hang Seng, BOCHK, Standard Chartered and others' own Open Banking APIs is a separate, not-yet-started project — a different data source with its own terms and reliability profile, not an extension of this one.
- **Bank credentials, login automation, or scraping authenticated sessions.** Deliberate: it would breach bank terms of service, break on every 2FA change, and is the wrong thing to put in an AI tool's hands.
- **Executing transactions.** Read and compare only. No transfers, no payments, no account opening.
- **Financial advice.** The server returns published figures with their conditions and dates. It does not recommend a product for a person's circumstances.
- **Banks outside Hong Kong.**
- **Personal account balances via Open Banking Phase III/IV.** These require bank approval, a registered TPP entity and a full consent flow — out of reach and out of scope for an open-source personal project.
