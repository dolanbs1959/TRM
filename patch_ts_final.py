import re

with open("src/app/estimate/estimate.page.ts", "r") as f:
    content = f.read()

# Make isPerSquareUnit public and add isPerLinearUnit
content = content.replace("private isPerSquareUnit(unit: string): boolean {", "isPerSquareUnit(unit: string): boolean {")
content = content.replace("return /\\bsq\\b/.test(normalized) || normalized.includes('square');", "return normalized.includes('sq') || normalized.includes('square');")

# Add isPerLinearUnit
new_method = """  isPerLinearUnit(unit: string): boolean {
    const normalized = this.normalizeText(unit);
    return normalized.includes('lf') || normalized.includes('linear');
  }"""

content = content.replace("isPerSquareUnit(unit: string): boolean {", new_method + "\n\n  isPerSquareUnit(unit: string): boolean {")

# Update calculation to use sqFootage as multiplier for both sq and lf
calc_replace = """    const sqFootage = Math.max(0, Number(item.sqFootage || this.selectedRoofSquareFootage || 0) || 0);
    const isSquare = this.isPerSquareUnit(item.unit);
    const isLinear = this.isPerLinearUnit(item.unit);
    const multiplier = (isSquare || isLinear) ? sqFootage : 1;
    const baseSubtotal = qty * price * multiplier;"""

content = re.sub(r"const sqFootage = Math\.max\(0, Number\(item\.sqFootage \|\| this\.selectedRoofSquareFootage \|\| 0\) \|\| 0\);\n\s*const multiplier = this\.isPerSquareUnit\(item\.unit\) \? sqFootage : 1;\n\s*const baseSubtotal = qty \* price \* multiplier;", calc_replace, content)

with open("src/app/estimate/estimate.page.ts", "w") as f:
    f.write(content)
