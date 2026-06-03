from playwright.sync_api import sync_playwright

def verify():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(color_scheme="dark")
        page = context.new_page()

        # Navigate to login
        page.goto("http://localhost:8100/login")

        # Wait for input fields and enter credentials
        page.fill('ion-input[type="tel"] input', '5555555555')
        page.fill('ion-input[type="password"] input', '1234')

        # Click login button
        page.click('ion-button')

        # Wait for navigation to home page
        page.wait_for_url("**/home", timeout=10000)

        # Wait for the job card to appear
        page.wait_for_selector('ion-card.job-card', timeout=10000)

        # Take screenshot of the specific job card to verify contrast
        card = page.locator('ion-card.job-card').first
        card.screenshot(path="/home/jules/verification/screenshots/job_card_dark_updated.png")
        print("Screenshot saved to /home/jules/verification/screenshots/job_card_dark_updated.png")

        browser.close()

if __name__ == "__main__":
    verify()
