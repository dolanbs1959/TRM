from playwright.sync_api import sync_playwright

def verify():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(color_scheme="dark")
        page = context.new_page()

        # Navigate directly to home, wait a sec just in case it redirects to login
        page.goto("http://localhost:8100/login")
        page.fill('ion-input[type="tel"] input', '5555555555')
        page.fill('ion-input[type="password"] input', '1234')
        page.click('ion-button')

        # We can mock the network if needed, but the original script in previous turns seemed to have a mock server running.
        # Wait for the card to be visible
        try:
            page.wait_for_selector('ion-card.job-card', timeout=5000)
        except Exception:
            # Let's take a screenshot of what's currently rendered if it times out
            page.screenshot(path="/home/jules/verification/screenshots/timeout_home.png", full_page=True)
            print("Timeout screenshot saved")
            browser.close()
            return

        card = page.locator('ion-card.job-card').first
        card.screenshot(path="/home/jules/verification/screenshots/job_card_dark_updated.png")
        print("Screenshot saved to /home/jules/verification/screenshots/job_card_dark_updated.png")

        browser.close()

if __name__ == "__main__":
    verify()
