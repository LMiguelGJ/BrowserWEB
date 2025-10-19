from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options

def main():
    # Configurar Chrome en modo headless (sin interfaz gráfica)
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")

    # Crear el driver
    service = Service("/usr/bin/google-chrome")  # Chrome ya está instalado en el contenedor
    driver = webdriver.Chrome(options=chrome_options)

    try:
        # Abrir la página
        driver.get("https://example.com")

        # Imprimir el HTML
        print(driver.page_source)
    finally:
        driver.quit()

if __name__ == "__main__":
    main()
