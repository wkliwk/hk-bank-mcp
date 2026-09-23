# HK Bank MCP — Product Definition

## Overview

**What it is:** An MCP (Model Context Protocol) server that gives any AI assistant — Claude Code, Claude Desktop, or any MCP client — accurate, live knowledge of the Hong Kong retail banking landscape.

**Who it's for:** People living in Hong Kong who want to ask an AI assistant practical banking questions in plain Cantonese or English, and get answers grounded in official data rather than a model's stale training memory.

**The problem it solves:** Ask an LLM "邊間銀行3個月港元定存息最高?" today and it will either refuse or hallucinate a rate from 2023. The data exists — HKMA publishes an open API with no key required, and HKMA regulation requires every retail bank to publish Phase I/II Open APIs for product information — but nothing connects it to an AI assistant. This project is that connection.

**Why it is not a wrapper:** Tools are designed around what a person asks, not around what an endpoint returns. Six HKMA locator endpoints collapse into one `hk_find_bank_location` tool; four banks' incompatible product feeds collapse into one ranked comparison. Tool descriptions, response shapes and token cost are iterated against an eval suite, not guessed.

## Principles

1. **Public data only.** No bank credentials, no login automation, no scraping of authenticated sessions. Every data source is either a published open API or a file the user exported themselves.
2. **Consolidate by user intent.** Fewer, richer tools beat one tool per endpoint. Per Anthropic's tool-design guidance, more tools do not mean better outcomes.
3. **High-signal responses.** Return names, rates, conditions and `as_of` dates. Never return internal IDs or hundreds of raw rows where a summary answers the question.
4. **Degrade gracefully.** One unreachable bank must never fail a comparison — return the rest and name what was unavailable.
5. **Never mislead about money.** A headline rate with hidden conditions is worse than no answer. Conditions, caps and effective dates are first-class fields, and published rates are labelled indicative, not an offer.

## Versions

Shipped incrementally — each version is independently installable and useful.

| Version | Theme | Milestone |
|---|---|---|
| v0.1 | HKMA Core — locations + interest rates | [v0.1](https://github.com/wkliwk/hk-bank-mcp/milestone/1) |
| v0.2 | HKMA Complete — legitimacy checker, contacts, evals | [v0.2](https://github.com/wkliwk/hk-bank-mcp/milestone/2) |
| v0.3 | Cross-Bank Compare — deposits, cards, mortgages | [v0.3](https://github.com/wkliwk/hk-bank-mcp/milestone/3) |
| v0.4 | Statement Analyzer — local CSV/PDF spending analysis | [v0.4](https://github.com/wkliwk/hk-bank-mcp/milestone/4) |

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

### 6. Cross-bank deposit comparison — `hk_compare_deposit_rates` (v0.3)

**Description:** Rank time-deposit and savings rates across Hong Kong banks in a single call.

**User flow:** User asks "邊間銀行3個月港元定存息最高?" → adapters fetch each bank's published product data in parallel → normalised, ranked, returned with conditions.

**Acceptance criteria:**
- Sorted best-first with bank, rate, tenor, minimum amount, effective date
- New-money / promotional / account-type conditions surfaced as explicit fields
- `unavailable_banks` listed rather than failing the whole call
- Top result verifiable against that bank's public website on the same day

### 7. Cross-bank credit card comparison — `hk_compare_credit_cards` (v0.3)

**Description:** Rank cards by what the user is optimising for — cashback, miles, annual fee, welcome offer — optionally for a spending category.

**Acceptance criteria:**
- Category-specific rates distinguished from base rates
- Annual fee shown with its waiver condition
- Welcome offers include spending requirement and time window

### 8. Cross-bank mortgage comparison — `hk_compare_mortgage_plans` (v0.3)

**Description:** Compare HIBOR-based and Prime-based mortgage plans with effective rates computed from live HIBOR, plus caps, rebates and estimated monthly payments.

**Acceptance criteria:**
- Effective rate computed from current HIBOR plus spread, with components and cap shown
- Monthly payment calculated and independently verifiable
- Indicative-rate disclaimer present in the response

### 9. Statement parsing — `hk_parse_statement` (v0.4)

**Description:** Parse a statement the user exported themselves (HSBC / Hang Seng CSV, or PDF) into structured transactions. Entirely local.

**Acceptance criteria:**
- Bank format auto-detected from headers
- Exact amount parsing; totals reconcile to the statement's closing balance
- No outbound network calls in this code path
- Scanned-image PDFs produce a clear, actionable error

### 10. Spending analysis — `hk_analyze_spending` (v0.4)

**Description:** Category breakdown, top merchants, recurring-charge detection and period-over-period change from parsed statements.

**Acceptance criteria:**
- Categorisation understands Hong Kong merchant conventions (Octopus, PARKNSHOP, MTR, FPS)
- Uncategorised transactions reported as their own counted bucket, never hidden
- Categorisation rules are user-extendable without code changes

## Design decisions

Recorded here because the reasoning, not the code, is what distinguishes this project. Full detail lives in the issue each one links to.

| Decision | Why |
|---|---|
| Tools grouped by what a person asks, not by API endpoint ([#4](https://github.com/wkliwk/hk-bank-mcp/issues/4)) | HKMA publishes 15 bank-info endpoints organised by its own departments. None corresponds to a question anyone actually asks. A product API already designed around user intent — Trading212's, say — would deserve one tool per endpoint; this one does not. |
| Filtering happens server-side, not in the model ([#4](https://github.com/wkliwk/hk-bank-mcp/issues/4)) | The full ATM dataset is roughly 401,000 tokens against a 200,000-token context. Returning it raw is not a design preference, it is impossible. Filters are exposed as optional parameters so the model still decides what it wants. |
| Every filter parameter is optional, and responses state the total match count ([#4](https://github.com/wkliwk/hk-bank-mcp/issues/4)) | The server must never decide what the user wanted. Silently truncating is worse than refusing: a model that cannot see it is missing results will answer confidently and wrongly. |
| Stale data is served, clearly labelled, when the upstream fails ([#3](https://github.com/wkliwk/hk-bank-mcp/issues/3)) | The HKMA API intermittently returns HTTP 502 with an HTML body, or nothing at all. A figure marked 30 hours old beats an error. With nothing cached, the error tells the model to say so rather than recall a number from memory. |
| Bodies are parsed defensively rather than with `.json()` ([#3](https://github.com/wkliwk/hk-bank-mcp/issues/3)) | A 502 carries HTML. `SyntaxError: Unexpected token '<'` tells an agent nothing it can act on, which is exactly when a model invents a plausible interest rate. |
| Jev is used for scam impersonation detection ([#20](https://github.com/wkliwk/hk-bank-mcp/issues/20)) | Whether `hsbc-hk-secure.com` imitates a bank is a semantic judgement no string comparison makes. Its confidence score sets how strongly to warn, so the model is never blindly trusted. The lookup degrades to list matching if the service is unavailable. |
| Jev is deliberately NOT used for transaction categorisation ([#18](https://github.com/wkliwk/hk-bank-mcp/issues/18)) | It is a hosted API, and merchant names reveal where someone lives, works, and seeks medical care. Keeping statement analysis local is a feature of this product, not a limitation of it. |

## Out of Scope

- **Bank credentials, login automation, or scraping authenticated sessions.** Deliberate: it would breach bank terms of service, break on every 2FA change, and is the wrong thing to put in an AI tool's hands. Statement data enters only through files the user exported themselves.
- **Executing transactions.** Read and compare only. No transfers, no payments, no account opening.
- **Financial advice.** The server returns published figures with their conditions and dates. It does not recommend a product for a person's circumstances.
- **Banks outside Hong Kong.**
- **Personal account balances via Open Banking Phase III/IV.** These require bank approval, a registered TPP entity and a full consent flow — out of reach and out of scope for an open-source personal project.
