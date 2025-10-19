import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

HTML_CACHE = ""


def fetch_html(url: str) -> str:
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    # Ruta binaria de Chrome dentro del contenedor
    chrome_options.binary_location = "/usr/bin/google-chrome"

    with webdriver.Chrome(options=chrome_options) as driver:
        driver.get(url)
        return driver.page_source


class SimpleHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_CACHE.encode("utf-8"))


def main():
    global HTML_CACHE

    url = os.environ.get("TARGET_URL", "https://example.com")

    try:
        HTML_CACHE = fetch_html(url)
    except Exception as e:
        HTML_CACHE = (
            f"<html><body><h1>Fallo al obtener {url}</h1>"
            f"<pre>{e}</pre></body></html>"
        )

    port = int(os.environ.get("PORT", "8080"))
    server = HTTPServer(("0.0.0.0", port), SimpleHandler)
    print(f"Servidor HTTP simple escuchando en puerto {port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
