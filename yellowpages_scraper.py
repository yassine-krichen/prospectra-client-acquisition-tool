from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

def scrape_yellowpages_playwright(query, location):
    base_url = "https://www.yellowpages.com"
    search_url = f"{base_url}/search?search_terms={query}&geo_location_terms={location}"
    print(f"[INFO] Target URL: {search_url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)  # Set headless=False to see browser
        context = browser.new_context()
        page = context.new_page()

        print("[INFO] Navigating to page...")
        page.goto(search_url, timeout=60000)

        print("[INFO] Page loaded. Extracting HTML content...")
        html = page.content()

        soup = BeautifulSoup(html, "html.parser")
        results = soup.find_all("div", class_="result")
        print(f"[INFO] Found {len(results)} business listing containers.")

        if not results:
            print("[WARN] No business listings found. Page structure may have changed.")
            print("[DEBUG] Printing part of page HTML:")
            print(soup.prettify()[:2000])  # print first 2K characters for inspection
            browser.close()
            return

        for idx, biz in enumerate(results):
            print(f"\n[INFO] Business #{idx + 1}")
            name = biz.find('a', class_='business-name')
            phone = biz.find('div', class_='phones phone primary')
            street = biz.find('div', class_='street-address')
            locality = biz.find('div', class_='locality')
            website = biz.find('a', class_='track-visit-website')

            print({
                "name": name.text.strip() if name else None,
                "phone": phone.text.strip() if phone else None,
                "address": f"{street.text.strip()} {locality.text.strip()}" if street and locality else None,
                "website": website['href'] if website else None
            })

        browser.close()

# Example run
scrape_yellowpages_playwright("plumber", "new york, ny")
