import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # Use dark mode user preference
        context = await browser.new_context(color_scheme='dark')
        page = await context.new_page()

        print("Navigating to login...")
        await page.goto("http://localhost:8100/login")

        # In a development environment with a mock setup, usually you can just login with 5555555555 and 5555
        print("Filling login form...")
        await page.fill('input[type="tel"]', '5555555555')
        await page.fill('input[type="password"]', '5555')

        print("Clicking login...")
        await page.click('ion-button')

        print("Waiting for home page load...")
        try:
            # Wait for home page, with a timeout
            await page.wait_for_url("**/home", timeout=10000)
            print("Successfully navigated to home page")

            # Wait a bit for data to render
            await asyncio.sleep(2)

            # Take screenshot of the dark mode job cards
            print("Taking screenshot of home page...")
            await page.screenshot(path="/home/jules/verification/screenshots/job_card_dark_final.png", full_page=True)
            print("Screenshot saved to /home/jules/verification/screenshots/job_card_dark_final.png")

            # Mark a job as selected, if there's any job-card
            try:
                await page.click('ion-card.job-card', timeout=2000)
                await asyncio.sleep(1)
                await page.screenshot(path="/home/jules/verification/screenshots/job_card_dark_selected.png", full_page=True)
                print("Screenshot with selected job saved to /home/jules/verification/screenshots/job_card_dark_selected.png")
            except Exception as e:
                print("Could not select job card:", e)

        except Exception as e:
            print(f"Failed to load home page: {e}")
            await page.screenshot(path="/home/jules/verification/screenshots/timeout_home_final.png", full_page=True)
            print("Timeout screenshot saved to /home/jules/verification/screenshots/timeout_home_final.png")

        await browser.close()

asyncio.run(run())
