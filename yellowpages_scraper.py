import requests
from bs4 import BeautifulSoup


def scrape_yellowpages(query, location):
    base_url = "https://www.yellowpages.com"
    search_url = f"{base_url}/search?search_terms={query}&geo_location_terms={location}"

    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(search_url, headers=headers)
    if response.status_code != 200:
        print(f"Failed to fetch page: {response.status_code}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    results = soup.find_all('div', class_='result')

    for biz in results:
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

# Example run
scrape_yellowpages("plumber", "new york, ny")
