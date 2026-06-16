import re

with open("src/app/estimate/estimate.page.ts", "r") as f:
    content = f.read()

# Replace private isPerSquareUnit with public
content = content.replace("private isPerSquareUnit(unit: string): boolean {", "isPerSquareUnit(unit: string): boolean {")
content = content.replace("return /\\bsq\\b/.test(normalized) || normalized.includes('square');", "return normalized.includes('sq') || normalized.includes('square');")

with open("src/app/estimate/estimate.page.ts", "w") as f:
    f.write(content)
