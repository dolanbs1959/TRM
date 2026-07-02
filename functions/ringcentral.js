const RingCentralSDK = require('@ringcentral/sdk').SDK;

const RC_SERVER = 'https://platform.ringcentral.com';

/**
 * Authenticates to RingCentral using JWT and returns a ready platform instance.
 * Re-authenticates on every call (stateless — suitable for Firebase Functions).
 */
async function getRingCentralPlatform({ clientId, clientSecret, jwt }) {
    const rcsdk = new RingCentralSDK({ server: RC_SERVER, clientId, clientSecret });
    const platform = rcsdk.platform();
    await platform.login({ jwt });
    return platform;
}

/**
 * Resolves the first phone number on the authenticated extension that has the SmsSender feature.
 */
async function resolveSmsFromNumber(platform) {
    const resp = await platform.get('/restapi/v1.0/account/~/extension/~/phone-number');
    const json = await resp.json();
    const record = (json.records || []).find(
        (r) => Array.isArray(r.features) && r.features.includes('SmsSender')
    );
    return record ? record.phoneNumber : null;
}

/**
 * Sends an SMS via RingCentral.
 *
 * @param {object} credentials  - { clientId, clientSecret, jwt }
 * @param {string} toNumber     - Recipient phone number in E.164 format
 * @param {string} text         - Message body
 * @returns {{ messageId: string, messageStatus: string, fromNumber: string }}
 */
async function sendSms({ clientId, clientSecret, jwt }, toNumber, text) {
    const platform = await getRingCentralPlatform({ clientId, clientSecret, jwt });
    const fromNumber = await resolveSmsFromNumber(platform);

    if (!fromNumber) {
        throw new Error('No phone number with SmsSender feature found on this RingCentral extension');
    }

    const smsResp = await platform.post('/restapi/v1.0/account/~/extension/~/sms', {
        from: { phoneNumber: fromNumber },
        to: [{ phoneNumber: toNumber }],
        text
    });
    const smsJson = await smsResp.json();

    return {
        messageId: smsJson.id,
        messageStatus: smsJson.messageStatus,
        fromNumber
    };
}

module.exports = { sendSms };
