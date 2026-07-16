const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const companyConfig = {
    name: 'The Roof Medic',
    address: '6519 Myers Rd E Unit 3, Bonney Lake, WA 98391',
    phone: '253-862-4412',
    email: 'contact@YourRoofMedic.com',
    logoPath: path.join(__dirname, '../src/assets/TRM_logo.png'),
};

function formatCurrency(value) {
    const amount = parseFloat(value);
    if (!Number.isFinite(amount)) return '$0.00';
    return `$${amount.toFixed(2)}`;
}

function formatDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
    } catch {
        return String(value);
    }
}

function formatAddressBlock(address) {
    if (!address) return '';
    const lines = [];
    const street = [address.street1, address.street2].filter(Boolean).join(' ');
    if (street) lines.push(street);
    const cityStateZip = [address.city, [address.state, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (cityStateZip) lines.push(cityStateZip);
    if (address.country) lines.push(address.country);
    return lines.map(line => `<div>${line}</div>`).join('');
}

function getLogoDataUrl() {
    try {
        const buffer = fs.readFileSync(companyConfig.logoPath);
        return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
        return '';
    }
}

function buildCustomerInfoHtml(invoiceData) {
    const { customer, billingAddress, jobAddress } = invoiceData;
    const name = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || 'Valued Customer';
    const billTo = billingAddress || customer?.primaryAddress;

    const invoiceMeta = invoiceData.invoiceMeta || {};
    const invoiceDate = invoiceMeta.invoiceDate ? formatDate(invoiceMeta.invoiceDate) : 'Pending';
    const dueDate = invoiceMeta.dueDate ? formatDate(invoiceMeta.dueDate) : 'Pending';
    const paymentTerms = invoiceMeta.paymentTerms || 'Net 15';
    const serviceDate = invoiceData.serviceOrder?.serviceDate ? formatDate(invoiceData.serviceOrder.serviceDate) : '';

    return `
        <div class="customer-block">
            <div>
                <strong>Bill To:</strong>
                <div style="margin-top: 4px;">${name}</div>
                ${formatAddressBlock(billTo)}
                ${customer?.phone ? `<div style="margin-top: 6px;">${customer.phone}</div>` : ''}
                ${customer?.email ? `<div>${customer.email}</div>` : ''}
            </div>
            <div>
                <strong>Service Location:</strong>
                <div style="margin-top: 4px;">${formatAddressBlock(jobAddress)}</div>
            </div>
            <div>
                <strong>Invoice Date:</strong>
                <div>${invoiceDate}</div>
            </div>
            <div>
                <strong>Due Date:</strong>
                <div>${dueDate}</div>
            </div>
            <div>
                <strong>Payment Terms:</strong>
                <div>${paymentTerms}</div>
            </div>
            <div>
                <strong>Service Date:</strong>
                <div>${serviceDate || 'Pending'}</div>
            </div>
        </div>`;
}

function buildDescriptionOfWorkHtml(invoiceData) {
    // The completed work is represented by the invoice line items, so a separate
    // Description of Work section is intentionally omitted.
    return '';
}

function buildLineItemsSectionHtml(invoiceData) {
    const lineItems = Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : [];

    if (lineItems.length === 0) {
        return `
            <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Line Items</h3>
            <p style="color: #888; font-size: 14px; margin-bottom: 40px;">No line items recorded.</p>`;
    }

    const hasSqFt = lineItems.some(item => (parseFloat(item.sqFootage) || 0) > 0);

    const rows = lineItems.map(item => {
        const status = String(item.lineStatus || '').toLowerCase().trim();
        const isCancelled = status === 'cancelled' || status === 'canceled';
        const rowClass = isCancelled ? 'cancelled-row' : '';
        const qty = isCancelled ? 0 : (parseFloat(item.quantity) || 0);
        const unitPrice = parseFloat(item.unitPrice) || 0;
        const lineTotal = isCancelled ? 0 : (parseFloat(item.lineTotal) || (qty * unitPrice));
        const sqFt = parseFloat(item.sqFootage) || 0;

        const sqFtCell = hasSqFt
            ? (sqFt > 0 ? `${sqFt.toLocaleString('en-US')}` : '—')
            : null;

        const qtyCell = isCancelled ? '—' : qty.toLocaleString('en-US');
        const unitPriceCell = isCancelled ? '$0.00' : formatCurrency(unitPrice);
        const lineTotalCell = formatCurrency(lineTotal);

        const sqFtTd = hasSqFt ? `<td class="numeric">${sqFtCell}</td>` : '';

        return `
            <tr class="${rowClass}">
                <td>${item.taskName || '—'}</td>
                <td class="description-cell">${item.description || 'No description available.'}</td>
                <td class="numeric center">${qtyCell}</td>
                ${sqFtTd}
                <td class="numeric">${unitPriceCell}</td>
                <td class="numeric">${lineTotalCell}</td>
            </tr>`;
    }).join('');

    const sqFtTh = hasSqFt ? '<th style="width: 12%;" class="numeric">Sq Ft</th>' : '';

    return `
        <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Line Items</h3>
        <table>
            <thead>
                <tr>
                    <th style="width: 18%;">Task</th>
                    <th style="width: auto;">Description</th>
                    <th style="width: 8%;" class="numeric">Qty</th>
                    ${sqFtTh}
                    <th style="width: 15%;" class="numeric">Unit Price</th>
                    <th style="width: 15%;" class="numeric">Line Total</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function buildFinancialSummaryHtml(invoiceData) {
    const { financialSummary } = invoiceData;
    const subtotal = parseFloat(financialSummary?.subtotal) || 0;
    const discountAmount = parseFloat(financialSummary?.discountAmount) || 0;
    const discountLabel = financialSummary?.discountLabel || 'Discount';
    const taxAmount = parseFloat(financialSummary?.taxAmount) || 0;
    const taxRate = parseFloat(financialSummary?.taxRate) || 0;
    const discountPercentage = parseFloat(financialSummary?.discountPercentage) || 0;
    const total = parseFloat(financialSummary?.total) || (subtotal - discountAmount + taxAmount);
    const balanceDue = parseFloat(financialSummary?.balanceDue) || total;

    const discountDisplay = discountAmount > 0
        ? `-${formatCurrency(discountAmount)}`
        : formatCurrency(0);
    const discountDisplayLabel = discountAmount > 0 && discountPercentage > 0
        ? `${discountLabel} (${discountPercentage.toFixed(2).replace(/\.00$/, '')}%)`
        : discountLabel;
    const taxDisplayLabel = `Sales Tax (${(taxRate * 100).toFixed(2)}%)`; 

    return `
        <div class="totals-container">
            <div class="totals">
                <div class="totals-row">
                    <span>Subtotal</span>
                    <span>${formatCurrency(subtotal)}</span>
                </div>
                <div class="totals-row">
                    <span>${discountDisplayLabel}</span>
                    <span>${discountDisplay}</span>
                </div>
                <div class="totals-row">
                    <span>${taxDisplayLabel}</span>
                    <span>${formatCurrency(taxAmount)}</span>
                </div>
                <div class="totals-row grand-total">
                    <span>Total</span>
                    <span>${formatCurrency(total)}</span>
                </div>
                <div class="totals-row grand-total" style="margin-top: 0; border-top: none;">
                    <span>Balance Due</span>
                    <span>${formatCurrency(balanceDue)}</span>
                </div>
            </div>
        </div>`;
}

function buildSignatureSectionHtml() {
    // Customer Acknowledgement section intentionally omitted from customer-facing invoice.
    return '';
}

async function resizePhotoForPdf(imageInput, maxWidth = 800) {
    try {
        if (typeof imageInput !== 'string' || imageInput.length === 0) {
            throw new Error('Image input is empty or not a string');
        }

        let buffer;
        if (imageInput.startsWith('data:image/')) {
            const base64Data = imageInput.replace(/^data:image\/[a-z]+;base64,/, '');
            buffer = Buffer.from(base64Data, 'base64');
        } else if (imageInput.match(/^https?:\/\//)) {
            const response = await fetch(imageInput);
            if (!response.ok) {
                throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
            }
            buffer = Buffer.from(await response.arrayBuffer());
        } else {
            throw new Error(`Unsupported image input format: ${imageInput.slice(0, 40)}...`);
        }

        if (!buffer || buffer.length === 0) {
            throw new Error('Image buffer is empty after decoding/fetching');
        }

        const metadata = await sharp(buffer).metadata();

        let resizedBuffer;
        if (metadata.width > maxWidth) {
            resizedBuffer = await sharp(buffer)
                .resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85, progressive: false })
                .toBuffer();
        } else {
            resizedBuffer = await sharp(buffer)
                .jpeg({ quality: 85, progressive: false })
                .toBuffer();
        }
        return `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    } catch (error) {
        console.error('[InvoiceGenerator] Photo resize failed:', error.message);
        return imageInput;
    }
}

async function buildPhotoGalleryHtml(photos, title) {
    const photoItems = await Promise.all(photos.map(async (photo, index) => {
        const src = photo.src || photo.dataUrl || photo.url || '';
        const notes = photo.notes || photo.description || ''; 
        const resizedSrc = src ? await resizePhotoForPdf(src, 800) : '';

        return `
            <div class="photo-item">
                <img src="${resizedSrc}" alt="${title} ${index + 1}" class="photo-img">
                ${notes ? `<div class="photo-notes">${notes}</div>` : ''}
            </div>`;
    }));

    return `
        <div class="photo-subsection">
            <h4 class="photo-subsection-title">${title}</h4>
            <div class="photo-grid">${photoItems.join('')}</div>
        </div>`;
}

async function buildPhotoSectionHtml(photos) {
    if (!Array.isArray(photos) || photos.length === 0) {
        return '';
    }

    const beforePhotos = photos.filter(p => String(p?.slot || '').toLowerCase() === 'before');
    const afterPhotos = photos.filter(p => String(p?.slot || '').toLowerCase() === 'after');

    const beforeHtml = beforePhotos.length > 0
        ? await buildPhotoGalleryHtml(beforePhotos, 'Before Photos')
        : '';
    const afterHtml = afterPhotos.length > 0
        ? await buildPhotoGalleryHtml(afterPhotos, 'After Photos')
        : '';

    if (!beforeHtml && !afterHtml) {
        return '';
    }

    return `
        <div class="section-3">
            <div class="photo-section-container">
                <h3 class="section-title">Service Photos</h3>
                ${beforeHtml}
                ${afterHtml}
            </div>
        </div>`;
}

function buildPaymentInfoHtml() {
    return `
        <div class="closing-section payment-info-section">
            <h3 class="section-title">Payment Information</h3>
            <div class="payment-info-grid">
                <div>
                    <div class="payment-info-label">Checks Payable To</div>
                    <div class="payment-info-value">The Roof Medic</div>
                </div>
                <div>
                    <div class="payment-info-label">Mail To</div>
                    <div class="payment-info-value">PO Box 8098</div>
                    <div class="payment-info-value">Bonney Lake, WA 98391</div>
                </div>
                <div>
                    <div class="payment-info-label">Online Payments</div>
                    <div class="payment-info-value">www.YourRoofMedic.com</div>
                </div>
                <div>
                    <div class="payment-info-label">Debit Cards</div>
                    <div class="payment-info-value">No Fee</div>
                </div>
                <div>
                    <div class="payment-info-label">Credit Cards</div>
                    <div class="payment-info-value">3.0% Processing Fee</div>
                </div>
                <div>
                    <div class="payment-info-label">Questions?</div>
                    <div class="payment-info-value">(253) 862-4412</div>
                    <div class="payment-info-value">contact@YourRoofMedic.com</div>
                </div>
            </div>
        </div>`;
}

function buildPaymentTermsHtml() {
    return `
        <div class="closing-section payment-terms-section">
            <h3 class="section-title">Payment Terms</h3>
            <p>Payment is due within 15 days of the Invoice Date unless otherwise noted.</p>
            <p>Past due balances are subject to a 1.5% monthly late fee.</p>
        </div>`;
}

function buildThankYouHtml() {
    return `
        <div class="closing-section thank-you-section">
            <p class="thank-you-title">Thank you for choosing The Roof Medic.</p>
            <p>We appreciate the opportunity to serve you.</p>
        </div>`;
}

async function generateInvoiceHtml(invoiceData) {
    const logoDataUrl = getLogoDataUrl();
    const logoHtml = logoDataUrl
        ? `<div class="logo-container"><img src="${logoDataUrl}" alt="${companyConfig.name}"></div>`
        : `<div class="company-name">${companyConfig.name}</div>`;

    const jobNumber = invoiceData.serviceOrder?.jobNumber || invoiceData.serviceOrder?.recordId || '—';
    const serviceOrderNumber = invoiceData.serviceOrder?.recordId || '—';

    const photoSectionHtml = await buildPhotoSectionHtml(invoiceData.photos);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice — Service Order #${serviceOrderNumber}</title>
<style>
    body {
        font-family: Arial, sans-serif;
        color: #333;
        margin: 0;
        padding: 40px;
    }
    .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 3px solid #f21616;
        padding-bottom: 20px;
        margin-bottom: 30px;
    }
    .logo-container img {
        max-width: 200px;
        max-height: 80px;
        object-fit: contain;
    }
    .company-info {
        text-align: right;
        font-size: 14px;
        line-height: 1.5;
    }
    .company-name {
        color: #f21616;
        font-weight: bold;
        font-size: 20px;
        margin-bottom: 5px;
    }
    .invoice-title {
        color: #f21616;
        font-weight: bold;
        font-size: 28px;
        margin-bottom: 8px;
    }
    .invoice-meta-line {
        font-size: 13px;
        color: #555;
    }
    .customer-block {
        margin-bottom: 40px;
        padding: 20px;
        background-color: #f9f9f9;
        border-left: 5px solid #f21616;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 15px;
    }
    .customer-block div {
        font-size: 14px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
    }
    .customer-block strong {
        display: inline-block;
        width: 130px;
        flex-shrink: 0;
        color: #333;
        margin-bottom: 2px;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 40px;
    }
    th, td {
        padding: 12px 15px;
        text-align: left;
        border-bottom: 1px solid #ddd;
        vertical-align: top;
    }
    th {
        background-color: #f21616;
        color: white;
        font-weight: bold;
        text-transform: uppercase;
        font-size: 12px;
        letter-spacing: 0.04em;
    }
    td {
        font-size: 14px;
    }
    td.description-cell {
        word-wrap: break-word;
        white-space: normal;
        max-width: 45%;
    }
    tr:nth-child(even) {
        background-color: #f9f9f9;
    }
    td.numeric, th.numeric {
        text-align: right;
    }
    td.numeric.center, th.numeric.center {
        text-align: center;
    }
    .cancelled-row td {
        text-decoration: line-through;
        color: #999;
    }
    .cancelled-row td.numeric {
        text-decoration: line-through;
        color: #999;
    }
    .totals-container {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 50px;
    }
    .totals {
        width: 320px;
    }
    .totals-row {
        display: flex;
        justify-content: space-between;
        padding: 10px 0;
        border-bottom: 1px solid #eee;
        font-size: 14px;
    }
    .totals-row.grand-total {
        font-weight: bold;
        font-size: 16px;
        border-bottom: 2px solid #333;
        border-top: 2px solid #333;
        color: #f21616;
        margin-top: 5px;
        padding: 15px 0;
    }
    .signature-container {
        margin-top: 60px;
        page-break-inside: avoid;
    }
    .signature-block {
        width: 350px;
    }
    .signature-lines {
        display: flex;
        gap: 60px;
        align-items: flex-start;
        page-break-inside: avoid;
    }
    .signature-line {
        text-align: center;
        font-size: 14px;
    }
    .signature-line .line {
        margin-bottom: 5px;
        white-space: nowrap;
    }
    .signature-line .label {
        color: #333;
    }
    .photo-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
    }
    .photo-item {
        border: 1px solid #ddd;
        padding: 10px;
        background-color: #fff;
        page-break-inside: avoid;
        break-inside: avoid;
    }
    .photo-img {
        max-width: 2.75in;
        max-height: 4in;
        width: auto;
        height: auto;
        object-fit: contain;
        display: block;
    }
    .photo-section {
        font-size: 13px;
        font-weight: bold;
        color: #f21616;
        margin-top: 10px;
    }
    .photo-notes {
        font-size: 12px;
        color: #666;
        margin-top: 8px;
        line-height: 1.4;
    }
    .photo-section-container {
        page-break-before: always;
        break-before: page;
        margin-top: 40px;
        padding: 20px;
    }
    .photo-subsection {
        margin-top: 24px;
    }
    .photo-subsection:first-of-type {
        margin-top: 0;
    }
    .photo-subsection-title {
        font-size: 15px;
        font-weight: bold;
        color: #333;
        margin-bottom: 12px;
        border-bottom: 1px solid #eee;
        padding-bottom: 6px;
    }
    .section-title {
        color: #f21616;
        font-size: 18px;
        margin: 0 0 20px 0;
        border-bottom: 2px solid #f21616;
        padding-bottom: 10px;
        page-break-after: avoid;
        break-after: avoid;
        page-break-inside: avoid;
        break-inside: avoid;
    }
    .section-3 {
        page-break-before: always;
        break-before: page;
    }
    .closing-section {
        page-break-inside: avoid;
        break-inside: avoid;
        margin-top: 30px;
    }
    .payment-info-section {
        margin-top: 40px;
    }
    .payment-info-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        font-size: 13px;
    }
    .payment-info-label {
        font-weight: bold;
        color: #555;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: 4px;
    }
    .payment-info-value {
        color: #333;
        line-height: 1.4;
    }
    .payment-terms-section p {
        font-size: 13px;
        color: #333;
        margin: 0 0 6px 0;
        line-height: 1.5;
    }
    .thank-you-section {
        text-align: center;
        margin-top: 40px;
        color: #333;
        font-size: 14px;
        line-height: 1.6;
    }
    .thank-you-title {
        font-weight: bold;
        color: #f21616;
        font-size: 15px;
        margin: 0 0 4px 0;
    }
    .legal-text {
        font-size: 10px;
        color: #666;
        text-align: justify;
        margin-top: 40px;
        line-height: 1.5;
        padding-top: 20px;
        border-top: 1px solid #eee;
        page-break-inside: avoid;
    }
    @media print { body { padding: 0; } }
</style>
</head>
<body>

<div class="header">
    ${logoHtml}
    <div class="company-info">
        <div class="invoice-title">INVOICE</div>
        <div class="company-name">${companyConfig.name}</div>
        <div>${companyConfig.address}</div>
        <div>${companyConfig.phone}</div>
        <div>${companyConfig.email}</div>
        <div style="margin-top: 10px;" class="invoice-meta-line"><strong>Service Order #:</strong> ${serviceOrderNumber}</div>
    </div>
</div>

${buildCustomerInfoHtml(invoiceData)}

${buildDescriptionOfWorkHtml(invoiceData)}

${buildLineItemsSectionHtml(invoiceData)}

${buildFinancialSummaryHtml(invoiceData)}

<div class="closing-page">
    ${buildPaymentInfoHtml()}
    ${buildPaymentTermsHtml()}
    ${buildThankYouHtml()}
</div>

${photoSectionHtml}

</body>
</html>`;

    return html;
}

module.exports = { generateInvoiceHtml, companyConfig };
