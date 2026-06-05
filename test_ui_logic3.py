from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 390, 'height': 844},
            user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)'
        )
        page = context.new_page()
        page.on("console", lambda msg: print(f"Console: {msg.text}"))

        page.goto("http://localhost:8100/login")
        page.fill('input[type="tel"]', "5555555555")
        page.fill('input[type="password"]', "5555")
        page.click('ion-button')

        try:
            page.wait_for_url("**/home", timeout=10000)
            page.wait_for_selector('ion-title:has-text("TRM Mobile")', timeout=10000)
            page.wait_for_timeout(2000) # Wait for rendering

            content = page.content()
            if "CLOCK OUT" in content:
                print("SUCCESS: Clock out text found in DOM.")
            else:
                print("FAILURE: Clock out text not found in DOM.")
        except Exception as e:
            print("Failure:", e)

        browser.close()

if __name__ == "__main__":
    run()
