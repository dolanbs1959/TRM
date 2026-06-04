import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # Use dark mode explicitly and matching view port
        context = await browser.new_context(
            color_scheme='dark',
            viewport={'width': 430, 'height': 932} # iPhone 14 Pro Max size approx
        )
        page = await context.new_page()

        print("Navigating to local server...")
        await page.goto('http://localhost:4200/login', wait_until='networkidle')

        print("Mocking login token and navigating to /home...")
        await page.evaluate("""() => {
            localStorage.setItem('trm.loggedInUser', JSON.stringify({
              "authKey": "mock_auth_key_1234",
              "user_id": "1",
              "first_name": "Test",
              "last_name": "Tech"
            }));
            localStorage.setItem('trm.homeState.schedule', JSON.stringify([
              {
                "id": "1001",
                "customerName": "John Doe",
                "address": "123 Main St",
                "city": "Anytown",
                "state": "CA",
                "zip": "90210",
                "phone": "555-123-4567",
                "email": "john@example.com",
                "jobType": "inspection"
              }
            ]));
        }""")

        await page.goto('http://localhost:4200/home', wait_until='networkidle')
        await page.wait_for_timeout(3000) # Give it some time to render

        print("Capturing screenshot of /home...")
        await page.screenshot(path='/home/jules/verification/screenshots/dark_mode_home_fixed2.png', full_page=True)
        print("Done. Screenshot saved to /home/jules/verification/screenshots/dark_mode_home_fixed2.png")
        await browser.close()

if __name__ == '__main__':
    asyncio.run(run())
