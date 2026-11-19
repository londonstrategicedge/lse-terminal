"""Web tools for the local terminal's AI panel: search, read a page, render a page.

WHY THESE RUN ON THE USER'S OWN MACHINE
The terminal is a download that runs on the user's computer, and it already
fetches from the internet there (the research paper reader). Search and page
reading work the same way: their machine, their IP, their network, exactly like
their browser. We do NOT proxy this through LSE. Routing strangers' page fetches
through our servers would mean carrying their traffic, their bandwidth and their
choice of URL, and it would put an LSE IP behind every page a user asks about.
(The HOSTED assistant is the opposite case and does use a sandboxed egress
service, because there the fetch is decided by a stranger and must not
originate on our backend directly.)

WHY STDLIB ONLY
The terminal's install is deliberately thin: no httpx, no requests, no
trafilatura. Everything here is urllib plus pypdf, which is already a
dependency for the paper reader. A web tool that needed a new package would
either bloat every install or silently not work in the frozen desktop build.
`browse` is the one exception and degrades to a clear instruction when
Playwright is absent, the same way the PDF reader does.

SSRF GUARD
The risk here is not our infrastructure, it is the user's own network. A page
(or a prompt-injected instruction inside one) can ask the agent to fetch
http://192.168.1.1/ or a cloud metadata address and read the result back. Every
hop is checked, not just the first URL, because a public host can redirect
inward.
"""

from __future__ import annotations

import html as _htmlmod  # aliased: `html` is a local variable all over this file
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

# A real browser UA. Plenty of publishers refuse an obviously scripted client,
# and the point of the tool is to read what the user would read.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

MAX_BYTES = 4 * 1024 * 1024
DEFAULT_TIMEOUT = 20
MAX_REDIRECTS = 5


def _ip_is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_multicast or addr.is_reserved
                or addr.is_unspecified) and addr.is_global


def _check_host(url: str) -> None:
    """Raise ValueError unless url is http(s) on a publicly routable host.

    Checks EVERY address the name resolves to. A host with one public record
    and one 127.0.0.1 record would otherwise pass and then connect to loopback.
    """
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError("only http(s) URLs are allowed")
    host = parts.hostname
    if not host:
        raise ValueError("no host in URL")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ValueError(f"cannot resolve {host}")
    for info in infos:
        ip = info[4][0]
        if not _ip_is_public(ip):
            raise ValueError(
                f"refusing {host}: it resolves to {ip}, which is on a private "
                "or local network. Web tools may only reach public sites.")


class _GuardedRedirects(urllib.request.HTTPRedirectHandler):
    """Re-run the host check on every redirect target.

    urllib follows redirects for us, so without this a public URL that 302s to
    a LAN address would be fetched with no check at all: the guard would have
    inspected only the URL we were given.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get(url: str, cap: int = MAX_BYTES,
             timeout: int = DEFAULT_TIMEOUT,
             data: Optional[bytes] = None) -> tuple[bytes, str, str]:
    """GET (or POST when data is given) with the guard applied. Returns
    (body, final_url, content_type)."""
    _check_host(url)
    opener = urllib.request.build_opener(_GuardedRedirects())
    req = urllib.request.Request(
        url, data=data,
        headers={"User-Agent": UA,
                 "Accept": "text/html,application/xhtml+xml,application/pdf,*/*",
                 "Accept-Language": "en-US,en;q=0.9"})
    with opener.open(req, timeout=timeout) as resp:
        body = resp.read(cap + 1)
        if len(body) > cap:
            body = body[:cap]
        return body, resp.geturl(), resp.headers.get("Content-Type", "")


_TAG_DROP = re.compile(
    r"(?is)<(script|style|noscript|svg|head|nav|footer|form|header|aside)[^>]*>.*?</\1>")
_TAGS = re.compile(r"(?s)<[^>]+>")
_WS = re.compile(r"[ \t\r\f\v]+")
_BLANKS = re.compile(r"\n\s*\n\s*\n+")
# Semantic wrappers, in preference order. Taking the article body when the page
# marks one is the single biggest quality win available without a real
# extraction library: without it the ECB's rate page opens with "Skip to
# navigation" and a 24-language menu before any content, and a model given that
# either summarises the menu or burns its budget scrolling past it.
_MAIN_RE = (re.compile(r"(?is)<article[^>]*>(.*?)</article>"),
            re.compile(r"(?is)<main[^>]*>(.*?)</main>"),
            re.compile(r'(?is)<div[^>]+(?:id|class)="[^"]*(?:article|content|post)-?(?:body|main|text)?[^"]*"[^>]*>(.*?)</div>'))


def readable(html: str) -> str:
    """HTML to something a model can read.

    Deliberately simple: prefer the page's own article container, strip the
    elements that never carry article text, then the tags, then collapse
    whitespace. Block-level tags become newlines first so paragraphs and list
    items do not run into one wall of words, which is what makes a naive
    tag-stripper's output so hard to read.
    """
    for pat in _MAIN_RE:
        m = pat.search(html)
        # Only trust the container if it holds most of the substance; some
        # sites wrap a teaser in <main> and keep the real text outside it.
        if m and len(m.group(1)) > 600:
            html = m.group(1)
            break
    text = _TAG_DROP.sub(" ", html)
    text = re.sub(r"(?i)<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>", "\n", text)
    text = _TAGS.sub(" ", text)
    # Full entity decode, not a handful of replacements: search titles came
    # back full of &#x27; and &amp; because the hand-rolled list only covered
    # named entities, and a model reading "Bank of England&#x27;s" repeats it.
    text = _htmlmod.unescape(text).replace("\xa0", " ")
    text = _WS.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANKS.sub("\n\n", text).strip()


def _title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return _WS.sub(" ", m.group(1)).strip()[:200] if m else ""


# ── search ────────────────────────────────────────────────────────────────
# DuckDuckGo's lite endpoint: no key, no quota, and it answers a residential
# IP perfectly well. (It refuses datacenter IPs, but here we are on the user's
# own connection, so the simple thing is also the right thing.)
_DDG_LITE = "https://lite.duckduckgo.com/lite/"
# Attribute quoting on this endpoint is single quotes for class and double for
# href, and it changes without notice, so match either. The first version of
# this parser assumed double quotes throughout and silently returned every
# result with an empty snippet.
_ROW_RE = re.compile(r"(?is)<tr\b([^>]*)>(.*?)</tr>")
_LINK_RE = re.compile(
    r"""(?is)<a\b[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>(.*?)</a>""")
_SNIPPET_RE = re.compile(r"""(?is)<td\b[^>]*class=["']result-snippet["'][^>]*>(.*?)</td>""")


def _clean(fragment: str) -> str:
    return readable(fragment)[:300]


def search(query: str, category: str = "web", recency: str = "",
           limit: int = 6) -> Dict[str, Any]:
    q = (query or "").strip()
    if not q:
        return {"error": "no query"}
    form = {"q": q}
    # DDG's own time filter. df=d/w/m/y, applied only when asked for, since a
    # filter on an evergreen question hides the best sources.
    tl = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(
        (recency or "").strip().lower())
    if tl:
        form["df"] = tl
    if (category or "").strip().lower() == "news":
        # lite has no news vertical; steering the query is the honest
        # approximation and beats claiming a filter we do not have.
        form["q"] = q + " news"
    try:
        body, _, _ = http_get(_DDG_LITE, cap=1_500_000,
                              data=urllib.parse.urlencode(form).encode())
    except (urllib.error.URLError, ValueError, OSError) as e:
        return {"error": f"search failed: {str(e)[:200]}",
                "note": "say you could not search rather than answering from memory"}
    html = body.decode("utf-8", "replace")
    want = max(1, min(limit, 10))
    results: List[Dict[str, str]] = []
    pending: Optional[Dict[str, str]] = None
    for attrs, row in _ROW_RE.findall(html):
        # SKIP ADS. DuckDuckGo interleaves paid rows marked result-sponsored,
        # and the first version of this parser handed them to the model as
        # ordinary results: an assistant citing an advert as its source for a
        # rate is worse than one that says it could not find the answer.
        if "result-sponsored" in attrs or "sponsored" in attrs:
            pending = None
            continue
        link = _LINK_RE.search(row)
        if link:
            if pending:
                results.append(pending)
            # href attributes are HTML-escaped, so a URL with a query string
            # arrives carrying &amp; and would 404 if handed back to fetch_url.
            url, title = _htmlmod.unescape(link.group(1)), link.group(2)
            # lite sometimes wraps links in its own redirector; unwrap so the
            # model gets a URL it can hand straight to fetch_url.
            if "duckduckgo.com/l/?uddg=" in url or url.startswith("//duckduckgo.com/l/"):
                qs = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                url = urllib.parse.unquote((qs.get("uddg") or [url])[0])
            pending = {"title": _clean(title), "url": url, "snippet": ""}
            continue
        snip = _SNIPPET_RE.search(row)
        if snip and pending is not None:
            pending["snippet"] = _clean(snip.group(1))
            results.append(pending)
            pending = None
        if len(results) >= want:
            break
    if pending and len(results) < want:
        results.append(pending)
    if not results:
        return {"query": q, "results": [],
                "note": "search returned nothing; rephrase, or say you could "
                        "not find it rather than answering from memory"}
    return {"query": q, "results": results}


# ── read one page ─────────────────────────────────────────────────────────

def fetch(url: str, max_chars: int = 8000) -> Dict[str, Any]:
    raw_url = (url or "").strip()
    if "://" not in raw_url:
        raw_url = "https://" + raw_url
    try:
        body, final, ctype = http_get(raw_url)
    except ValueError as e:
        return {"error": str(e)}
    except urllib.error.HTTPError as e:
        return {"error": f"the site returned HTTP {e.code}", "url": raw_url}
    except (urllib.error.URLError, OSError) as e:
        return {"error": f"could not reach it: {str(e)[:160]}", "url": raw_url}

    cap = max(500, min(int(max_chars or 8000), 20000))
    if "application/pdf" in ctype.lower() or final.lower().split("?")[0].endswith(".pdf"):
        try:
            from io import BytesIO

            from pypdf import PdfReader
        except ImportError:
            return {"error": "PDF reading needs pypdf, which is not installed "
                             "in this build", "url": final}
        try:
            reader = PdfReader(BytesIO(body))
            out = []
            for i, page in enumerate(reader.pages):
                if i >= 40:
                    out.append(f"... ({len(reader.pages) - i} more pages omitted)")
                    break
                out.append(page.extract_text() or "")
            text = "\n".join(out).strip()
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not read the PDF: {str(e)[:150]}", "url": final}
        return {"url": final, "kind": "pdf", "text": text[:cap],
                "truncated": len(text) > cap}

    html = body.decode("utf-8", "replace")
    text = readable(html)
    result = {"url": final, "kind": "page", "title": _title(html),
              "text": text[:cap], "truncated": len(text) > cap}
    if len(text) < 200:
        # Almost no text usually means a JavaScript shell or a bot wall. Say so,
        # otherwise the model summarises an empty page as if it were content.
        result["note"] = ("very little text came back, so this is probably a "
                          "JavaScript-rendered page or a bot wall. Try the "
                          "browse tool, which renders the page properly.")
    return result


# ── render a page in a real browser ───────────────────────────────────────

def browse(url: str, max_chars: int = 8000) -> Dict[str, Any]:
    """Render with a real browser so JavaScript pages produce real text.

    Browser choice, in order:
      1. the user's installed Chrome (channel="chrome")
      2. the user's installed Edge (channel="msedge")
      3. Playwright's own bundled Chromium
    The installed browser is preferred deliberately. It is already on the
    machine (no extra download), it ships the proprietary codecs Chromium
    lacks, and it presents a normal consumer fingerprint, so it trips far fewer
    bot walls than a bare automation build. The bundled Chromium is the
    fallback for machines with neither.
    """
    raw_url = (url or "").strip()
    if "://" not in raw_url:
        raw_url = "https://" + raw_url
    try:
        _check_host(raw_url)
    except ValueError as e:
        return {"error": str(e)}
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"error": "browse needs Playwright, which is not installed. "
                         "Install it next to the engine with: "
                         "pip install playwright   (no browser download is "
                         "needed if you already have Chrome or Edge). "
                         "fetch_url works without it for ordinary pages."}
    last = ""
    try:
        with sync_playwright() as pw:
            browser = None
            # Chromium's setuid sandbox refuses to start as root, which happens
            # when the terminal runs inside a container or a root WSL shell.
            # Only then do we pass --no-sandbox: on a normal desktop account
            # the browser sandbox is a real protection and stays on.
            import os as _os
            root_args = (["--no-sandbox"]
                         if hasattr(_os, "geteuid") and _os.geteuid() == 0 else [])
            for channel in ("chrome", "msedge", None):
                try:
                    kw = {"headless": True, "args": root_args}
                    if channel:
                        kw["channel"] = channel
                    browser = pw.chromium.launch(**kw)
                    break
                except Exception as e:  # noqa: BLE001
                    last = str(e)[:200]
            if browser is None:
                return {"error": "no usable browser found. Install Chrome or "
                                 "Edge, or run: playwright install chromium. "
                                 f"Last error: {last}"}
            try:
                page = browser.new_page(user_agent=UA,
                                        viewport={"width": 1366, "height": 900})
                page.goto(raw_url, wait_until="domcontentloaded", timeout=30_000)
                # Give a single-page app time to hydrate, but cap it: waiting
                # for full network idle never finishes on pages with analytics
                # beacons or long polling.
                try:
                    page.wait_for_load_state("networkidle", timeout=6_000)
                except Exception:  # noqa: BLE001
                    pass
                # The check above saw only the address asked for. A page can
                # send the browser on (a redirect, a script) to this machine
                # or the LAN, the terminal's own page included, which shows a
                # broker's prices; what such an address holds is never read.
                final = page.url
                try:
                    _check_host(final)
                except ValueError as e:
                    return {"error": f"the page went on to {final}, which "
                                     f"web tools do not read: {e}"}
                title, html = page.title(), page.content()
                links = page.eval_on_selector_all(
                    "a[href]",
                    "els => els.map(e => ({t: e.innerText.trim().slice(0,70), "
                    "h: e.href})).filter(l => l.t && l.h.startsWith('http'))")
            finally:
                browser.close()
    except Exception as e:  # noqa: BLE001
        return {"error": f"the browser failed: {str(e)[:250]}"}

    cap = max(500, min(int(max_chars or 8000), 20000))
    text = readable(html)
    seen, out_links = set(), []
    for l in links:
        if l["h"] in seen:
            continue
        seen.add(l["h"])
        out_links.append({"text": l["t"], "url": l["h"]})
        if len(out_links) >= 20:
            break
    return {"url": final, "kind": "rendered", "title": title,
            "text": text[:cap], "truncated": len(text) > cap,
            "links": out_links}
