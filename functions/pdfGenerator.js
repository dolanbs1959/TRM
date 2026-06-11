const fs = require('fs');
const path = require('path');
const { calculateTax, getTaxRate } = require('./taxUtility');

const companyConfig = {
    name: "The Roof Medic",
    address: "6519 Myers Rd E Unit 3, Bonney Lake, WA 98391",
    phone: "253-862-4412",
    email: "contact@YourRoofMedic.com",
    logoUrl: path.join(__dirname, '../src/assets/TRM_logo.png')
};

function isPerSquareUnit(unit) {
    const normalized = String(unit || '').toLowerCase().trim();
    return /\bsq\b/.test(normalized) || normalized.includes('square');
}

function generatePDFHtml(job, lineItems, signatureData, roofStructures, totalSquareFootage) {
    const customerFirstName = job['93'] || '';
    const customerLastName = job['94'] || '';
    const customerName = `${customerFirstName} ${customerLastName}`.trim();

    const serviceAddress = (job['106'] || '').trim();
    
    // Extract zip code from full address for tax calculation
    const zipMatch = serviceAddress.match(/\b\d{5}\b/);
    const addressZip = zipMatch ? zipMatch[0] : '';

    const email = job['142'] || '';
    const phone = job['95'] || '';

    const submissionDate = new Date().toLocaleDateString();
    const signatureDate = submissionDate;
    const digitalSignatureDataUrl = signatureData || '';
    const hasSignature = !!digitalSignatureDataUrl;

    let subtotal = 0;
    const lineItemsHtml = lineItems.map(item => {
        const qty = item.qty || 1;
        const price = item.unitPrice || 0;
        const uom = item.uom || 'ea';
        const sqFootage = item.sqFootage || totalSquareFootage || 0;
        const multiplier = isPerSquareUnit(uom) ? sqFootage : 1;
        const total = qty * price * multiplier;
        subtotal += total;
        return `
            <tr>
                <td>${qty}</td>
                <td>${item.description || ''} ${uom !== 'ea' ? `(${uom})` : ''}</td>
                <td>$${price.toFixed(2)}</td>
                <td>$${total.toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    const taxAmount = calculateTax(subtotal, addressZip);
    const taxRate = getTaxRate(addressZip);
    const grandTotal = subtotal + taxAmount;

    // Build roof structures HTML
    let roofStructuresHtml = '';
    if (roofStructures && Array.isArray(roofStructures) && roofStructures.length > 0) {
        roofStructuresHtml = `
            <div style="margin-bottom: 20px; padding: 15px; background-color: #f9f9f9; border-left: 5px solid #f21616;">
                <div style="font-weight: bold; margin-bottom: 10px; color: #f21616;">Roof Structures:</div>
                ${roofStructures.map(roof => `
                    <div style="font-size: 14px; margin-bottom: 5px;">
                        <strong>${roof.name || 'Unnamed Roof'}</strong> - ${roof.squareFootage || 0} sq ft (${roof.material || 'N/A'}, ${roof.pitch || 'N/A'} pitch)
                    </div>
                `).join('')}
                <div style="font-size: 14px; margin-top: 10px; font-weight: bold;">
                    Total Square Footage: ${totalSquareFootage || 0} sq ft
                </div>
            </div>
        `;
    }

    // Load template
    const templatePath = path.join(__dirname, 'template.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders
    // html = html.replace(/{{COMPANY_LOGO}}/g, companyConfig.logoUrl);
    html = html.replace(/{{COMPANY_NAME}}/g, companyConfig.name);
    html = html.replace(/{{COMPANY_ADDRESS}}/g, companyConfig.address);
    html = html.replace(/{{COMPANY_PHONE}}/g, companyConfig.phone);
    html = html.replace(/{{COMPANY_EMAIL}}/g, companyConfig.email);

    html = html.replace(/{{CUSTOMER_NAME}}/g, customerName);
    html = html.replace(/{{SUBMISSION_DATE}}/g, submissionDate);
    html = html.replace(/{{SERVICE_ADDRESS}}/g, serviceAddress);
    html = html.replace(/{{CUSTOMER_PHONE}}/g, phone);
    html = html.replace(/{{CUSTOMER_EMAIL}}/g, email);

    html = html.replace(/{{ROOF_STRUCTURES_HTML}}/g, roofStructuresHtml);
    html = html.replace(/{{LINE_ITEMS_HTML}}/g, lineItemsHtml);
    html = html.replace(/{{SUBTOTAL}}/g, `$${subtotal.toFixed(2)}`);
    html = html.replace(/{{TAX_RATE_PERCENT}}/g, (taxRate * 100).toFixed(2));
    html = html.replace(/{{TAX_AMOUNT}}/g, `$${taxAmount.toFixed(2)}`);
    html = html.replace(/{{GRAND_TOTAL}}/g, `$${grandTotal.toFixed(2)}`);

    // Conditional signature handling
    const signatureImageHtml = digitalSignatureDataUrl
        ? `<img class="signature-img" src="${digitalSignatureDataUrl}" alt="Digital Signature">`
        : '';
    html = html.replace(/{{SIGNATURE_IMAGE_HTML}}/g, signatureImageHtml);

    const signatureTextHtml = hasSignature
        ? `Signed by: ${customerName} on ${signatureDate}`
        : '';
    html = html.replace(/{{SIGNATURE_TEXT}}/g, signatureTextHtml);

    // Show/hide signature container based on whether it's signed
    if (!hasSignature) {
        html = html.replace(/<div class="signature-container">[\s\S]*?<\/div>/g, '');
    }

    return html;
}

module.exports = {
    companyConfig,
    generatePDFHtml
};