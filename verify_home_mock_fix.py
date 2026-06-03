import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # MUST set record_video_dir to capture the video
        context = await browser.new_context(
            color_scheme='dark',
            record_video_dir='/home/jules/verification/videos'
        )
        page = await context.new_page()

        print("Navigating to login page...")
        await page.goto("http://localhost:8100/login", wait_until="networkidle")
        await page.wait_for_timeout(500)

        # Mock the HTTP response for the login
        print("Mocking login response...")
        await page.route("**/login", lambda route: route.fulfill(
            status=200,
            json={
                "success": True,
                "user": {
                    "3": {"value": 1234},
                    "6": {"value": "Test"},
                    "7": {"value": "User"}
                }
            }
        ))

        # Mock schedule response
        await page.route("**/get-schedule", lambda route: route.fulfill(
            status=200,
            json=[
                {
                    "3": {"value": 1},
                    "93": {"value": "John"},
                    "94": {"value": "Doe"},
                    "106": {"value": "123 Main St"},
                    "92": {"value": "Springfield"},
                    "105": {"value": "IL"},
                    "104": {"value": "62701"},
                    "108": {"value": "Scheduled"},
                    "44": {"value": "10:00 AM"},
                    "40": {"value": "Inspection"},
                    "10": {"value": "Check the roof for leaks"}
                }
            ]
        ))

        # Also mock weather response as it's called on home init
        await page.route("**/weather*", lambda route: route.fulfill(
            status=200,
            json={
                "weather": [{"description": "clear sky", "icon": "01d"}],
                "main": {"temp": 72.5, "feels_like": 75.0, "humidity": 45},
                "wind": {"speed": 5.0},
                "name": "Springfield",
                "sys": {"country": "US"}
            }
        ))

        print("Logging in via UI...")
        # Fill in phone and PIN
        await page.fill('input[type="tel"]', '5555555555')
        await page.wait_for_timeout(500)

        await page.fill('input[type="password"]', '1234')
        await page.wait_for_timeout(500)

        await page.click('ion-button:has-text("CHECK SCHEDULE")')
        await page.wait_for_timeout(500)

        print("Waiting for navigation to home...")
        await page.wait_for_timeout(3000)

        print(f"Current URL: {page.url}")

        print("Taking screenshot...")
        await page.screenshot(path="/home/jules/verification/screenshots/dark_mode_home_final.png")
        print(f"Screenshot saved to /home/jules/verification/screenshots/dark_mode_home_final.png")

        await page.wait_for_timeout(1000) # hold final state for the video

        # MUST close context to save video
        await context.close()
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
