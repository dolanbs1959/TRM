const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
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

async function resizePhotoForPdf(base64DataUrl, maxWidth = 1000) {
    try {
        const base64Data = base64DataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const originalSize = buffer.length;
        const metadata = await sharp(buffer).metadata();
        const originalDimensions = `${metadata.width} × ${metadata.height}`;

        let resizedBuffer;
        if (metadata.width > maxWidth) {
            resizedBuffer = await sharp(buffer)
                .resize(maxWidth, null, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({
                    quality: 85,
                    progressive: false
                })
                .toBuffer();
        } else {
            resizedBuffer = await sharp(buffer)
                .jpeg({
                    quality: 85,
                    progressive: false
                })
                .toBuffer();
        }

        const resizedMetadata = await sharp(resizedBuffer).metadata();
        const resizedDimensions = `${resizedMetadata.width} × ${resizedMetadata.height}`;
        const resizedSize = resizedBuffer.length;

        const resizedDataUrl = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;

        console.log('[PDFGenerator] Photo resize:', {
            originalDimensions,
            resizedDimensions,
            originalSize: `${(originalSize / 1024).toFixed(2)} KB`,
            resizedSize: `${(resizedSize / 1024).toFixed(2)} KB`,
            reduction: `${((1 - resizedSize / originalSize) * 100).toFixed(1)}%`
        });

        return resizedDataUrl;
    } catch (error) {
        console.error('[PDFGenerator] Photo resize failed:', error.message);
        return base64DataUrl;
    }
}

async function generatePDFHtml(job, lineItems = [], signatureData, roofStructures = [], totalSquareFootage = 0, serviceNotes = '', cleanMaintenanceScheduledFor = '', repairServicesScheduledFor = '', inspectionPhotos = [], msDiscountAmount = 0, otherDiscountAmount = 0) {
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
    function formatUsDate(value) {
        if (!value) return '';

        const [year, month, day] = String(value).split('-');
        return (year && month && day) ? `${month}-${day}-${year}` : value;
    }
    let subtotal = 0;
    
    // Safety check for lineItems and separate into two groups
    const safeLineItems = Array.isArray(lineItems) ? lineItems : [];
    const areaBasedItems = [];
    const otherItems = [];
    
    safeLineItems.forEach(item => {
        const qty = parseFloat(item.qty) || 0;
        const price = parseFloat(item.unitPrice) || 0;
        const uom = item.uom || 'ea';
        const sqFootage = parseFloat(item.sqFootage) || parseFloat(totalSquareFootage) || 0;
        
        const multiplier = isPerSquareUnit(uom) ? sqFootage : 1;
        const total = qty * price * multiplier;
        
        subtotal += total;
        
        const itemData = {
            qty,
            price,
            uom,
            sqFootage,
            total,
            description: item.description || 'N/A'
        };
        
        if (isPerSquareUnit(uom)) {
            areaBasedItems.push(itemData);
        } else {
            otherItems.push(itemData);
        }
    });
    
    // Generate Area-Based Services table HTML
    const areaBasedItemsHtml = areaBasedItems.map(item => {
        const rows = `
            <tr>
                <td>${item.description}</td>
                <td>$${item.price.toFixed(2)}${item.uom ? ` / ${item.uom}` : ''}</td>
                <td>${item.sqFootage} sq ft</td>
                <td>$${item.total.toFixed(2)}</td>
            </tr>
            <tr>
                <td colspan="4" style="padding: 5px 15px; font-size: 12px; color: #999; font-style: italic; border-bottom: 1px solid #ddd;">
                    ${item.qty} × $${item.price.toFixed(2)} × ${item.sqFootage} sq ft = $${item.total.toFixed(2)}
                </td>
            </tr>
        `;
        return rows;
    }).join('');
    
    // Generate Other Services table HTML
    const otherItemsHtml = otherItems.map(item => {
        return `
            <tr>
                <td>${item.qty}</td>
                <td>${item.description}</td>
                <td>$${item.price.toFixed(2)}${item.uom ? ` / ${item.uom}` : ''}</td>
                <td>$${item.total.toFixed(2)}</td>
            </tr>
        `;
    }).join('');
    
    // Determine which sections to display
    let lineItemsSectionHtml = '';
    
    if (areaBasedItems.length > 0 && otherItems.length > 0) {
        // Both categories exist - display both with headings
        lineItemsSectionHtml = `
            <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Full Service Roof Clean & Maintenance Packages</h3>
            <table>
                <thead>
                    <tr>
                        <th style="width: 40%;">Description</th>
                        <th style="width: 25%;">Unit Price</th>
                        <th style="width: 20%;">Service Area</th>
                        <th style="width: 15%;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${areaBasedItemsHtml}
                </tbody>
            </table>
            
            <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Additional Services & Repairs</h3>
            <table>
                <thead>
                    <tr>
                        <th style="width: 10%;">Qty</th>
                        <th style="width: 50%;">Description</th>
                        <th style="width: 20%;">Unit Price</th>
                        <th style="width: 20%;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${otherItemsHtml}
                </tbody>
            </table>
        `;
    } else if (areaBasedItems.length > 0) {
        // Only area-based services
        lineItemsSectionHtml = `
            <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Full Service Roof Clean & Maintenance Packages</h3>
            <table>
                <thead>
                    <tr>
                        <th style="width: 40%;">Description</th>
                        <th style="width: 25%;">Unit Price</th>
                        <th style="width: 20%;">Service Area</th>
                        <th style="width: 15%;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${areaBasedItemsHtml}
                </tbody>
            </table>
        `;
    } else if (otherItems.length > 0) {
        // Only other services
        lineItemsSectionHtml = `
            <h3 style="color: #f21616; font-size: 18px; margin: 30px 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Additional Services & Repairs</h3>
            <table>
                <thead>
                    <tr>
                        <th style="width: 10%;">Qty</th>
                        <th style="width: 50%;">Description</th>
                        <th style="width: 20%;">Unit Price</th>
                        <th style="width: 20%;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${otherItemsHtml}
                </tbody>
            </table>
        `;
    }

    const militarySeniorDiscount = Math.min(subtotal, parseFloat(msDiscountAmount) || 0);
    const additionalDiscount = Math.min(subtotal - militarySeniorDiscount, parseFloat(otherDiscountAmount) || 0);
    const taxableSubtotal = Math.max(0, subtotal - militarySeniorDiscount - additionalDiscount);
    const taxAmount = calculateTax(taxableSubtotal, addressZip);
    const taxRate = getTaxRate(addressZip);
    const grandTotal = taxableSubtotal + taxAmount;

    const signatureSectionHtml = hasSignature
        ? `
        <div class="signature-block">
            <div class="signature-img-container">
                <img class="signature-img" src="${digitalSignatureDataUrl}" alt="Signature">
            </div>
            <div class="signature-text">
                Signed by: ${customerName} on ${submissionDate}
            </div>
        </div>
        `
        : `
        <div class="signature-block unsigned-signature">
            <div class="signature-lines">
                <div class="signature-line">
                    <div class="line">____________________________________</div>
                    <div class="label">Signature</div>
                </div>
                <div class="signature-line">
                    <div class="line">______________________</div>
                    <div class="label">Date</div>
                </div>
            </div>
        </div>
        `;

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

    // Generate Service Notes section HTML
    const servicePledgeText = 'It is our pledge to render careful, professional cleaning services using reasonable care to obtain satisfactory results. We do not guarantee all leaks or cracks in any type of roof material will be discovered. Factors of installation and/or deterioration that are disguised or covered cannot be predicted in the hands of even the most careful workman. Gutters that are rusted and/or brittle can potentially leak or break during a cleaning process. We do guarantee that we will be careful to clean the roof in a manner that will reduce the risk of any of these instances.';
    
    let serviceNotesHtml = '';
    if (serviceNotes && serviceNotes.trim()) {
        // Preserve line breaks by converting newlines to <br> tags
        const formattedNotes = serviceNotes.replace(/\n/g, '<br>');
        serviceNotesHtml = `
            <div style="margin-top: 0.5in; margin-bottom: 30px; padding: 20px; background-color: #f9f9f9; border-left: 5px solid #f21616;">
                <h3 style="color: #f21616; font-size: 18px; margin: 0 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Service Notes</h3>
                <p style="font-size: 13px; color: #555; margin: 0 0 15px 0; line-height: 1.6;">${servicePledgeText}</p>
                <div style="font-size: 14px; color: #333; line-height: 1.6; white-space: pre-wrap;">${formattedNotes}</div>
            </div>
        `;
    } else {
        // Only display explanatory text if no user notes
        serviceNotesHtml = `
            <div style="margin-top: 0.5in; margin-bottom: 30px; padding: 20px; background-color: #f9f9f9; border-left: 5px solid #f21616;">
                <h3 style="color: #f21616; font-size: 18px; margin: 0 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Service Notes</h3>
                <p style="font-size: 13px; color: #555; margin: 0; line-height: 1.6;">${servicePledgeText}</p>
            </div>
        `;
    }
    
    // Generate Dates of Services section HTML
    const datesOfServiceText = 'All dates subject to change based on weather and other unforeseen circumstances. You will be notified as soon as possible if services need to be rescheduled. There is no exact time of arrival for these dates.';
    
    const datesOfServicesHtml = `
        <div style="margin-bottom: 30px; padding: 20px; background-color: #f9f9f9; border-left: 5px solid #f21616;">
            <h3 style="color: #f21616; font-size: 18px; margin: 0 0 15px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Dates of Services</h3>
            <p style="font-size: 13px; color: #555; margin: 0 0 20px 0; line-height: 1.6;">${datesOfServiceText}</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <div style="font-size: 14px; color: #333; font-weight: bold; margin-bottom: 8px;">Clean / Maintenance Services Scheduled For</div>
                    <div style="font-size: 16px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 8px;">${formatUsDate(cleanMaintenanceScheduledFor) || '________________________'}</div>
                </div>
                <div>
                    <div style="font-size: 14px; color: #333; font-weight: bold; margin-bottom: 8px;">Repair Services Scheduled For</div>
                    <div style="font-size: 16px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 8px;">${formatUsDate(repairServicesScheduledFor) || '________________________'}</div>
                </div>
            </div>
        </div>
    `;

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
        '{{LINE_ITEMS_SECTION_HTML}}': lineItemsSectionHtml,
        '{{SERVICE_NOTES_HTML}}': serviceNotesHtml,
        '{{DATES_OF_SERVICES_HTML}}': datesOfServicesHtml,
        '{{SUBTOTAL}}': `$${subtotal.toFixed(2)}`,
        '{{MILITARY_SENIOR_DISCOUNT}}': `$${militarySeniorDiscount.toFixed(2)}`,
        '{{ADDITIONAL_DISCOUNT}}': `$${additionalDiscount.toFixed(2)}`,
        '{{TAX_RATE_PERCENT}}': (taxRate * 100).toFixed(2),
        '{{TAX_AMOUNT}}': `$${taxAmount.toFixed(2)}`,
        '{{GRAND_TOTAL}}': `$${grandTotal.toFixed(2)}`,
        '{{SIGNATURE_SECTION_HTML}}': signatureSectionHtml
    };

    // Apply replacements
    for (const [key, value] of Object.entries(replacements)) {
        html = html.replace(new RegExp(key, 'g'), value);
    }

    // Generate Inspection Photos section HTML
    let inspectionPhotosHtml = '';
    if (Array.isArray(inspectionPhotos) && inspectionPhotos.length > 0) {
        console.log('[PDFGenerator] Processing inspection photos', { photoCount: inspectionPhotos.length });

        const photosHtml = await Promise.all(inspectionPhotos.map(async (photo, index) => {
            const sectionLabel = photo.section || 'General';
            const notesHtml = photo.notes && photo.notes.trim()
                ? `<div style="font-size: 12px; color: #666; margin-top: 8px; line-height: 1.4;">${photo.notes}</div>`
                : '';

            const resizedSrc = await resizePhotoForPdf(photo.src, 1000);

            return `
                <div class="photo-item">
                    <img src="${resizedSrc}" alt="Inspection Photo ${index + 1}" class="photo-img">
                    <div class="photo-section">${sectionLabel}</div>
                    ${notesHtml}
                </div>
            `;
        }));

        inspectionPhotosHtml = `
            <!-- Section 3: Inspection Photos (Forced New Page) -->
            <div class="section-3">
                <div class="photo-section-container">
                    <h3 style="color: #f21616; font-size: 18px; margin: 0 0 20px 0; border-bottom: 2px solid #f21616; padding-bottom: 10px;">Inspection Photos</h3>
                    <div class="photo-grid">
                        ${photosHtml.join('')}
                    </div>
                </div>
            </div>
        `;
    }

    // Insert inspection photos section at the end, before closing body tag
    if (inspectionPhotosHtml) {
        html = html.replace('</body>', `${inspectionPhotosHtml}</body>`);
    }

    return html;
}

module.exports = { companyConfig, generatePDFHtml };