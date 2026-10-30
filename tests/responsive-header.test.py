import importlib.util
import shutil
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")

if importlib.util.find_spec("playwright") is None or CHROMIUM is None:
    print("responsive-header.test.py: skipped (Playwright or Chromium is unavailable)")
    sys.exit(0)

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base_url = f"http://127.0.0.1:{server.server_port}/"

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROMIUM,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            page = browser.new_page()
            page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
            page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
            page.route(
                "**/api/**",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body='{"googleClientId":null}',
                ),
            )

            dialogs = (
                ("accountBtn", "accountDialog"),
                ("settingsBtn", "settingsDialog"),
                ("searchBtn", "searchDialog"),
                ("plansBtn", "plansDialog"),
            )

            for width in (320, 360, 375, 390, 430, 768, 1024, 1440):
                page.set_viewport_size({"width": width, "height": 850})
                page.goto(base_url, wait_until="networkidle")
                if width == 320:
                    pwa = page.evaluate(
                        """async () => {
                          const manifestLink = document.querySelector('link[rel="manifest"]');
                          const response = await fetch(manifestLink.href);
                          const manifest = await response.json();
                          const icons = await Promise.all(manifest.icons.map(async (icon) => {
                            const image = new Image();
                            image.src = new URL(icon.src, manifestLink.href).href;
                            await image.decode();
                            return [image.naturalWidth, image.naturalHeight];
                          }));
                          const appleIcon = new Image();
                          appleIcon.src = document.querySelector('link[rel="apple-touch-icon"]').href;
                          await appleIcon.decode();
                          const registrations = 'serviceWorker' in navigator
                            ? await navigator.serviceWorker.getRegistrations()
                            : [];
                          return {
                            ok: response.ok,
                            mime: response.headers.get('content-type'),
                            name: manifest.short_name,
                            display: manifest.display,
                            iconSizes: icons,
                            appleIcon: [appleIcon.naturalWidth, appleIcon.naturalHeight],
                            serviceWorkers: registrations.length,
                          };
                        }"""
                    )
                    assert pwa["ok"], "manifest did not load over HTTP"
                    assert pwa["name"] == "PromptLab" and pwa["display"] == "standalone"
                    assert pwa["iconSizes"] == [[192, 192], [512, 512]]
                    assert pwa["appleIcon"] == [180, 180]
                    assert pwa["serviceWorkers"] == 0, "no service worker should intercept/cache user data"
                geometry = page.evaluate(
                    """() => {
                      const rect = (selector) => {
                        const box = document.querySelector(selector).getBoundingClientRect();
                        return { left: box.left, right: box.right, width: box.width };
                      };
                      return {
                        viewport: document.documentElement.clientWidth,
                        pageWidth: document.documentElement.scrollWidth,
                        brand: rect('.brand'),
                        account: rect('#accountBtn'),
                        settings: rect('#settingsBtn'),
                        search: rect('#searchBtn'),
                        shell: rect('.app-shell'),
                        toolPanel: rect('#toolPanel'),
                        linksPanel: rect('#linksPanel'),
                      };
                    }"""
                )
                assert geometry["pageWidth"] <= width, (
                    f"horizontal overflow at {width}px: document width {geometry['pageWidth']}px"
                )
                assert geometry["search"]["left"] >= 0 and geometry["search"]["right"] <= width, (
                    f"search button clipped at {width}px: {geometry['search']}"
                )
                assert geometry["brand"]["right"] <= geometry["account"]["left"], (
                    f"brand overlaps action bar at {width}px"
                )
                assert geometry["account"]["right"] <= geometry["settings"]["left"]
                assert geometry["settings"]["right"] <= geometry["search"]["left"]
                for selector in ("shell", "toolPanel", "linksPanel"):
                    assert geometry[selector]["left"] >= 0 and geometry[selector]["right"] <= width, (
                        f"{selector} is clipped at {width}px: {geometry[selector]}"
                    )

                for trigger_id, dialog_id in dialogs:
                    page.locator(f"#{trigger_id}").click()
                    assert page.locator(f"#{dialog_id}").evaluate("dialog => dialog.open"), (
                        f"{dialog_id} did not open at {width}px"
                    )
                    page.locator(f"#{dialog_id}").evaluate("dialog => dialog.close()")

                print(
                    f"responsive-header.test.py: {width}px OK; no page/panel overflow; 4 dialogs OK"
                )
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
