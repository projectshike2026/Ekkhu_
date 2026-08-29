# EKKHU Research & Technical Documentation 📚

This directory contains research papers, technical reports, and developer guides for the **EKKHU Academic OS** conversational AI platform.

---

## 📄 Contents

| File | Description | Format |
|---|---|---|
| [`MULTI_TENANT_SECURITY_IDOR_PAPER.md`](./MULTI_TENANT_SECURITY_IDOR_PAPER.md) | **Multi-Tenant Security & Vulnerability Engineering Paper** covering IDOR analysis, client-header forgery exploits, PIN keyspace expansion ($10^6$), sliding-window rate limiting, and zero-trust SQLite session architecture. | Markdown (`.md`) |
| [`ekkhu_optimization_ieee.tex`](./ekkhu_optimization_ieee.tex) | **IEEE Conference Format Paper** detailing the full engineering optimization, latency breakdown, database connection consolidation, and Gemini Multimodal Audio ASR architecture. | LaTeX (`.tex`) |
| [`FREE_TIER_FULLSTACK_AI_GUIDE.md`](./FREE_TIER_FULLSTACK_AI_GUIDE.md) | **Comprehensive Developer Guide & Case Study** covering all real-world issues (Render ephemeral disk wipes, Turso edge DB, mobile WebRTC audio constraints, PythonAnywhere TTS fallbacks, cp1252 fixes, and latency tuning). Perfect for blog/community posts. | Markdown (`.md`) |
| [`fix_voice_mood.md`](./fix_voice_mood.md) | **Mobile WebRTC Voice Fix Note** explaining the Android screen overlay permissions issue and native recorder fallback strategy. | Markdown (`.md`) |

---

### How to Compile the IEEE Paper:
- You can upload `ekkhu_optimization_ieee.tex` to [Overleaf](https://www.overleaf.com/) or compile locally with:
  ```bash
  pdflatex docs/ekkhu_optimization_ieee.tex
  ```
