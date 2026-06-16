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

function generatePDFHtml(job, lineItems = [], signatureData, roofStructures = [], totalSquareFootage = 0) {
    // Defensive coding: Ensure job is an object to prevent crashes
    const safeJob = job || {};
    
    const customerFirstName = safeJob['93'] || '';
    const customerLastName = safeJob['94'] || '';
    const customerName = `${customerFirstName} ${customerLastName}`.trim();

    const serviceAddress = (safeJob['106'] || '').trim();
    const zipMatch = serviceAddress.match(/\b\d{5}\b/);
    const addressZip = zipMatch ? zipMatch[0] : '';

    const email = safeJob['142'] || '';
    const phone = safeJob['95'] || '';

    const submissionDate = new Date().toLocaleDateString();
    const digitalSignatureDataUrl = signatureData || '';
    const hasSignature = !!digitalSignatureDataUrl;

    let subtotal = 0;
    
    // Safety check for lineItems
    const lineItemsHtml = (Array.isArray(lineItems) ? lineItems : []).map(item => {
        const qty = parseFloat(item.qty) || 0;
        const price = parseFloat(item.unitPrice) || 0;
        const uom = item.uom || 'ea';
        const sqFootage = parseFloat(item.sqFootage) || parseFloat(totalSquareFootage) || 0;
        
        const multiplier = isPerSquareUnit(uom) ? sqFootage : (uom.toLowerCase().includes('lf') ? sqFootage : 1);
        const total = qty * price * multiplier;
        
        subtotal += total;
        
        return `
            <tr>
                <td>${qty}</td>
                <td>${item.description || 'N/A'} ${uom !== 'ea' ? `(${uom})` : ''}</td>
                <td>$${price.toFixed(2)}</td>
                <td>$${total.toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    const taxAmount = calculateTax(subtotal, addressZip);
    const taxRate = getTaxRate(addressZip);
    const grandTotal = subtotal + taxAmount;

    let roofStructuresHtml = '';
    if (Array.isArray(roofStructures) && roofStructures.length > 0) {
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

    const templatePath = path.join(__dirname, 'template.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    // Mappings for Template
    const replacements = {
        '{{COMPANY_NAME}}': companyConfig.name,
        '{{COMPANY_ADDRESS}}': companyConfig.address,
        '{{COMPANY_PHONE}}': companyConfig.phone,
        '{{COMPANY_EMAIL}}': companyConfig.email,
        '{{CUSTOMER_NAME}}': customerName || 'Valued Customer',
        '{{SUBMISSION_DATE}}': submissionDate,
        '{{SERVICE_ADDRESS}}': serviceAddress || 'N/A',
        '{{CUSTOMER_PHONE}}': phone || 'N/A',
        '{{CUSTOMER_EMAIL}}': email || 'N/A',
        '{{ROOF_STRUCTURES_HTML}}': roofStructuresHtml,
        '{{LINE_ITEMS_HTML}}': lineItemsHtml,
        '{{SUBTOTAL}}': `$${subtotal.toFixed(2)}`,
        '{{TAX_RATE_PERCENT}}': (taxRate * 100).toFixed(2),
        '{{TAX_AMOUNT}}': `$${taxAmount.toFixed(2)}`,
        '{{GRAND_TOTAL}}': `$${grandTotal.toFixed(2)}`,
        '{{SIGNATURE_IMAGE_HTML}}': hasSignature ? `<img class="signature-img" src="${digitalSignatureDataUrl}" alt="Signature">` : '',
        '{{SIGNATURE_TEXT}}': hasSignature ? `Signed by: ${customerName} on ${submissionDate}` : ''
    };

    // Apply replacements
    for (const [key, value] of Object.entries(replacements)) {
        html = html.replace(new RegExp(key, 'g'), value);
    }

    // Clean up empty signature container if not signed
    if (!hasSignature) {
        html = html.replace(/<div class="signature-container">[\s\S]*?<\/div>/g, '');
    }

    return html;
}

module.exports = { companyConfig, generatePDFHtml };