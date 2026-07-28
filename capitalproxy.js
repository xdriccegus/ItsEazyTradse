/**
 * Netlify Function — Capital.com Proxy
 * Inoltra le richieste a Capital.com bypassando CORS.
 */

const https = require('https');

exports.handler = async (event) => {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: corsHeaders()
        };
    }

    const targetUrl = event.headers['x-target-url'];

    if (!targetUrl || !targetUrl.includes('capital')) {
        return {
            statusCode: 400,
            headers: corsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ error: 'X-Target-URL mancante o non valido' })
        };
    }

    try {
        const parsed = new URL(targetUrl);
        const reqHeaders = {
            'Content-Type': 'application/json'
        };

        // Copia gli header di autenticazione Capital.com
        const eventHeaders = event.headers;
        if (eventHeaders['x-cap-api-key'])    reqHeaders['X-CAP-API-KEY']    = eventHeaders['x-cap-api-key'];
        if (eventHeaders['cst'])              reqHeaders['CST']              = eventHeaders['cst'];
        if (eventHeaders['x-security-token']) reqHeaders['X-SECURITY-TOKEN'] = eventHeaders['x-security-token'];

        // Rimuovi header vuoti
        Object.keys(reqHeaders).forEach(k => { if (!reqHeaders[k]) delete reqHeaders[k]; });

        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname + (parsed.search || ''),
                method: event.httpMethod,
                headers: reqHeaders
            };

            const proxyReq = https.request(options, (proxyRes) => {
                let data = '';
                proxyRes.on('data', c => data += c);
                proxyRes.on('end', () => {
                    const respHeaders = corsHeaders({ 'Content-Type': 'application/json' });

                    // Esponi i token di sessione Capital.com
                    if (proxyRes.headers['cst'])              respHeaders['CST']              = proxyRes.headers['cst'];
                    if (proxyRes.headers['x-security-token']) respHeaders['X-SECURITY-TOKEN'] = proxyRes.headers['x-security-token'];

                    resolve({
                        statusCode: proxyRes.statusCode,
                        headers: respHeaders,
                        body: data
                    });
                });
            });

            proxyReq.on('error', e => {
                reject(e);
            });

            if (event.body) proxyReq.write(event.body);
            proxyReq.end();
        });

        return result;

    } catch (e) {
        return {
            statusCode: 502,
            headers: corsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ error: 'Proxy error: ' + e.message })
        };
    }
};

function corsHeaders(extra = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CAP-API-KEY, CST, X-SECURITY-TOKEN, X-Target-URL',
        'Access-Control-Expose-Headers': 'CST, X-SECURITY-TOKEN',
        ...extra
    };
}
