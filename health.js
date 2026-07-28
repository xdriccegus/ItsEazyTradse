/**
 * Netlify Function — Health Check
 */
exports.handler = async () => {
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: '2.0.0', platform: 'netlify' })
    };
};
