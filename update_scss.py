import re

with open("src/app/home/home.page.scss", "r") as f:
    content = f.read()

# Remove the .job-card block inside dark mode
# We only want to remove .job-card {} within the @media (prefers-color-scheme: dark) block
# Using string replace since it's a specific block

dark_mode_job_card = """  .job-card {
    background: var(--ion-color-step-100, #1e1e1e) !important;
    border: 1px solid var(--ion-color-step-200, #333) !important;

    &.job-selected {
      background: #3a3212 !important;
      outline: 2px solid #f2b705;
    }

    &.job-complete {
      background: #2a2a2a !important;
    }
  }

"""

new_content = content.replace(dark_mode_job_card, "")

# Now add .job-contact-link styling for dark mode and ensure others are set
dark_mode_text_styles = """  .customer-name {
    color: #ffffff !important;
  }

  .job-location {
    color: #f5f5f5 !important;
  }"""

new_dark_mode_text_styles = """  .customer-name {
    color: #ffffff !important;
  }

  .job-location {
    color: #ffffff !important;
  }

  .job-contact-link {
    color: #00e5ff !important;
  }"""

new_content = new_content.replace(dark_mode_text_styles, new_dark_mode_text_styles)

with open("src/app/home/home.page.scss", "w") as f:
    f.write(new_content)
