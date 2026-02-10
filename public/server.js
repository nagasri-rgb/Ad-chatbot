const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Policy database
const POLICIES = {
    fairHousing: {
        protectedClasses: ['race', 'color', 'religion', 'national origin', 'sex', 'disability', 'familial status'],
        prohibitedTerms: [
            'no kids', 'no children', 'adults only', 'mature individuals', 'singles only',
            'couples only', 'perfect for newlyweds', 'family only', 'no students',
            'ideal for retirees', 'young professionals', 'empty nesters',
            'married couples', 'single persons', 'divorced', 'widowed',
            'senior', 'elderly', 'young', 'older persons',
            'men only', 'women only', 'male', 'female tenants',
            'christian', 'muslim', 'jewish', 'hindu', 'no atheists', 'religious',
            'caucasian', 'african american', 'asian', 'hispanic', 'latino', 'white', 'black',
            'english speakers only', 'speaks english', 'american citizens',
            'no wheelchairs', 'able-bodied', 'physically fit', 'no disabled',
            'exclusive', 'restricted', 'private community', 'select clientele'
        ]
    },
    meta: {
        imageTextLimit: 20,
        maxConsecutiveCaps: 3
    }
};

// API endpoint to fetch and analyze landing page
app.post('/api/analyze-page', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Fetch the page with timeout
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            maxRedirects: 5,
            validateStatus: (status) => status < 500
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // Extract page information
        const pageContent = {
            success: true,
            title: $('title').text().trim(),
            metaDescription: $('meta[name="description"]').attr('content') || '',
            headings: [],
            bodyText: '',
            hasContactForm: $('form').length > 0,
            hasPhoneNumber: false,
            hasEmail: false,
            hasPrivacyPolicy: false,
            hasTerms: false,
            images: $('img').length,
            forms: $('form').length,
            links: $('a').length,
            protocol: new URL(url).protocol
        };

        // Extract headings
        $('h1, h2, h3').each((i, elem) => {
            const text = $(elem).text().trim();
            if (text) pageContent.headings.push(text);
        });

        // Extract body text
        pageContent.bodyText = $('body').text().replace(/\s+/g, ' ').trim();

        // Check for contact information
        pageContent.hasPhoneNumber = /\+?[\d\s\-\(\)]{10,}/.test(pageContent.bodyText);
        pageContent.hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(pageContent.bodyText);

        // Check for privacy policy
        pageContent.hasPrivacyPolicy = /privacy\s*policy/i.test(pageContent.bodyText) || 
                                        $('a[href*="privacy"]').length > 0;

        // Check for terms
        pageContent.hasTerms = /terms\s*(and|&)?\s*conditions|terms\s*of\s*(use|service)/i.test(pageContent.bodyText) ||
                               $('a[href*="terms"]').length > 0;

        res.json(pageContent);

    } catch (error) {
        console.error('Error fetching page:', error.message);
        
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return res.json({
                success: false,
                timeout: true,
                message: 'Page took too long to load (>10 seconds)'
            });
        }

        if (error.response) {
            return res.json({
                success: false,
                error: true,
                statusCode: error.response.status,
                message: `Server returned ${error.response.status} error`
            });
        }

        res.json({
            success: false,
            error: true,
            message: error.message || 'Failed to fetch landing page'
        });
    }
});

// API endpoint to analyze compliance
app.post('/api/check-compliance', async (req, res) => {
    try {
        const { adText, landingPage, platform, imageInfo, landingPageContent } = req.body;

        const results = {
            violations: [],
            warnings: [],
            passed: [],
            totalChecks: 0,
            passedChecks: 0,
            criticalViolations: 0
        };

        // Analyze text
        if (adText) {
            analyzeAdText(adText, platform, results);
        }

        // Analyze landing page
        if (landingPage) {
            analyzeLandingPage(landingPage, platform, landingPageContent, results);
        }

        // Analyze image
        if (imageInfo) {
            analyzeImage(imageInfo, platform, results);
        }

        // Calculate score
        const baseScore = results.totalChecks > 0 
            ? Math.round((results.passedChecks / results.totalChecks) * 100) 
            : 0;
        
        let score = baseScore;
        score -= (results.criticalViolations * 15);
        score -= (results.warnings.length * 5);
        score = Math.max(0, Math.min(100, score));

        results.score = score;
        results.approved = results.criticalViolations === 0 && results.violations.length === 0;
        results.platform = platform;

        res.json(results);

    } catch (error) {
        console.error('Error in compliance check:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function analyzeAdText(text, platform, results) {
    const lowerText = text.toLowerCase();

    // Fair Housing Act - Discriminatory Language
    results.totalChecks++;
    const foundDiscriminatory = POLICIES.fairHousing.prohibitedTerms.filter(term =>
        lowerText.includes(term.toLowerCase())
    );

    if (foundDiscriminatory.length > 0) {
        results.criticalViolations++;
        results.violations.push({
            title: '🚨 Fair Housing Act Violation - Discriminatory Language',
            description: `CRITICAL: Found prohibited discriminatory terms: "${foundDiscriminatory.join('", "')}". This violates the Fair Housing Act and both Meta and Google Ads policies.`,
            severity: 'critical',
            policy: 'Fair Housing Act § 3604(c)'
        });
    } else {
        results.passedChecks++;
        results.passed.push({
            title: '✅ No Discriminatory Language Detected',
            description: 'Ad text complies with Fair Housing Act requirements.'
        });
    }

    // Meta Special Ad Category
    if (platform === 'meta' || platform === 'both') {
        results.totalChecks++;
        results.passedChecks++;
        results.passed.push({
            title: '⚠️ Meta Special Ad Category Declaration Required',
            description: 'Declare ad under "Housing" special ad category in Meta Ads Manager. Age: 18-65+, All genders, Min 15-mile radius.'
        });
    }

    // Excessive Capitalization
    if (platform === 'meta' || platform === 'both') {
        results.totalChecks++;
        const capsWords = text.split(' ').filter(word =>
            word === word.toUpperCase() && word.length > 1 && /[A-Z]/.test(word)
        );
        if (capsWords.length > POLICIES.meta.maxConsecutiveCaps) {
            results.violations.push({
                title: 'Excessive Capitalization (Meta)',
                description: `Found ${capsWords.length} all-caps words. Reduce to ${POLICIES.meta.maxConsecutiveCaps} or fewer.`,
                severity: 'high',
                policy: 'Meta Advertising Standards'
            });
        } else {
            results.passedChecks++;
            results.passed.push({
                title: '✅ Appropriate Capitalization',
                description: 'Text uses appropriate capitalization.'
            });
        }
    }

    // Unsubstantiated Claims
    results.totalChecks++;
    const superlatives = ['best', 'cheapest', 'lowest price', 'guaranteed returns', 'highest returns'];
    const foundSuperlatives = superlatives.filter(term => lowerText.includes(term));
    if (foundSuperlatives.length > 0) {
        results.warnings.push({
            title: 'Unsubstantiated Claims',
            description: `Claims like "${foundSuperlatives.join('", "')}" require proof and substantiation.`,
            severity: 'high'
        });
    } else {
        results.passedChecks++;
    }

    // Financial terms
    results.totalChecks++;
    if (/emi|loan|finance|mortgage|credit|interest|apr/i.test(text)) {
        results.warnings.push({
            title: 'Financial Terms Require Full Disclosure',
            description: 'Provide complete disclosure of all terms, rates, and conditions (Truth in Lending Act).',
            severity: 'high'
        });
    } else {
        results.passedChecks++;
    }

    // Google: Government affiliation
    if (platform === 'google' || platform === 'both') {
        results.totalChecks++;
        if (/government|official|approved by|certified by government/i.test(text)) {
            results.criticalViolations++;
            results.violations.push({
                title: 'Misleading Government Affiliation (Google)',
                description: 'Ad suggests government affiliation which is prohibited.',
                severity: 'critical',
                policy: 'Google Ads - Misrepresentation'
            });
        } else {
            results.passedChecks++;
        }
    }

    // CTA check
    results.totalChecks++;
    const hasCTA = /contact|call|visit|book|register|enquire|inquire|schedule|apply|learn more/i.test(text);
    if (hasCTA) {
        results.passedChecks++;
        results.passed.push({
            title: '✅ Clear Call-to-Action Present',
            description: 'Ad contains a clear call-to-action.'
        });
    } else {
        results.warnings.push({
            title: 'No Clear Call-to-Action',
            description: 'Consider adding a CTA to improve performance.',
            severity: 'low'
        });
    }
}

function analyzeLandingPage(url, platform, pageContent, results) {
    try {
        const urlObj = new URL(url);

        // HTTPS check
        results.totalChecks++;
        if (urlObj.protocol !== 'https:') {
            if (platform === 'google' || platform === 'both') {
                results.criticalViolations++;
                results.violations.push({
                    title: '🚨 Insecure Landing Page - HTTPS Required',
                    description: 'Google Ads REQUIRES HTTPS. Your URL uses HTTP which will be rejected.',
                    severity: 'critical',
                    policy: 'Google Ads - Landing Page Requirements'
                });
            } else {
                results.warnings.push({
                    title: 'Insecure Connection (HTTP)',
                    description: 'HTTPS is strongly recommended.',
                    severity: 'high'
                });
            }
        } else {
            results.passedChecks++;
            results.passed.push({
                title: '✅ Secure HTTPS Connection',
                description: 'Landing page uses HTTPS protocol.'
            });
        }

        if (pageContent && pageContent.success) {
            // Contact Information
            results.totalChecks++;
            if (!pageContent.hasPhoneNumber && !pageContent.hasEmail && !pageContent.hasContactForm) {
                results.criticalViolations++;
                results.violations.push({
                    title: '🚨 Missing Contact Information',
                    description: 'Landing page MUST have contact information (phone, email, or form).',
                    severity: 'critical',
                    policy: 'Both platforms - Transparency'
                });
            } else {
                results.passedChecks++;
                let methods = [];
                if (pageContent.hasPhoneNumber) methods.push('phone');
                if (pageContent.hasEmail) methods.push('email');
                if (pageContent.hasContactForm) methods.push('contact form');
                results.passed.push({
                    title: '✅ Contact Information Present',
                    description: `Includes: ${methods.join(', ')}.`
                });
            }

            // Privacy Policy
            results.totalChecks++;
            if (!pageContent.hasPrivacyPolicy) {
                if (platform === 'google' || platform === 'both') {
                    results.criticalViolations++;
                    results.violations.push({
                        title: '🚨 Missing Privacy Policy (Google Required)',
                        description: 'Google Ads REQUIRES a visible privacy policy link.',
                        severity: 'critical',
                        policy: 'Google Ads - Privacy Policy'
                    });
                } else {
                    results.warnings.push({
                        title: 'Privacy Policy Not Detected',
                        description: 'Privacy policy highly recommended.',
                        severity: 'high'
                    });
                }
            } else {
                results.passedChecks++;
                results.passed.push({
                    title: '✅ Privacy Policy Found',
                    description: 'Landing page includes privacy policy.'
                });
            }

            // Content Quality
            results.totalChecks++;
            const wordCount = pageContent.bodyText.split(/\s+/).filter(w => w.length > 0).length;
            if (wordCount < 100) {
                results.warnings.push({
                    title: 'Thin Content',
                    description: `Very little content (${wordCount} words). Add more details.`,
                    severity: 'high'
                });
            } else if (wordCount < 300) {
                results.warnings.push({
                    title: 'Limited Content',
                    description: `Minimal content (${wordCount} words).`,
                    severity: 'medium'
                });
            } else {
                results.passedChecks++;
                results.passed.push({
                    title: '✅ Adequate Content',
                    description: `${wordCount} words of content.`
                });
            }

            // Images
            results.totalChecks++;
            if (pageContent.images === 0) {
                results.warnings.push({
                    title: 'No Images Found',
                    description: 'Include high-quality property images.',
                    severity: 'high'
                });
            } else if (pageContent.images < 3) {
                results.warnings.push({
                    title: 'Few Images',
                    description: `Only ${pageContent.images} image(s). Add more.`,
                    severity: 'medium'
                });
            } else {
                results.passedChecks++;
                results.passed.push({
                    title: '✅ Images Present',
                    description: `${pageContent.images} images found.`
                });
            }

            // Discriminatory content on page
            results.totalChecks++;
            const bodyTextLower = pageContent.bodyText.toLowerCase();
            const foundDiscriminatory = POLICIES.fairHousing.prohibitedTerms.filter(term =>
                bodyTextLower.includes(term.toLowerCase())
            );

            if (foundDiscriminatory.length > 0) {
                results.criticalViolations++;
                results.violations.push({
                    title: '🚨 Discriminatory Content on Landing Page',
                    description: `Found: "${foundDiscriminatory.join('", "')}". Violates Fair Housing Act.`,
                    severity: 'critical',
                    policy: 'Fair Housing Act § 3604(c)'
                });
            } else {
                results.passedChecks++;
                results.passed.push({
                    title: '✅ No Discriminatory Content',
                    description: 'Landing page complies with Fair Housing Act.'
                });
            }

            // Pricing
            results.totalChecks++;
            const hasPricing = /₹|rs\.?|inr|price|cost|starting from|\d+\s*lac|\d+\s*crore|\$\d+/i.test(pageContent.bodyText);
            if (!hasPricing) {
                results.warnings.push({
                    title: 'No Pricing Information',
                    description: 'Display pricing or price range for transparency.',
                    severity: 'medium'
                });
            } else {
                results.passedChecks++;
                results.passed.push({
                    title: '✅ Pricing Information Found',
                    description: 'Includes pricing details.'
                });
            }

        } else if (pageContent && pageContent.timeout) {
            results.totalChecks++;
            results.criticalViolations++;
            results.violations.push({
                title: '🚨 Page Load Timeout',
                description: 'Page took >10 seconds. Target: <3 seconds.',
                severity: 'critical',
                policy: 'Both platforms - Page Experience'
            });
        } else if (pageContent && pageContent.error) {
            results.totalChecks++;
            results.criticalViolations++;
            results.violations.push({
                title: '🚨 Landing Page Not Accessible',
                description: 'Unable to load landing page. Ad will be rejected.',
                severity: 'critical'
            });
        }

    } catch (e) {
        results.totalChecks++;
        results.criticalViolations++;
        results.violations.push({
            title: '🚨 Invalid URL Format',
            description: 'Invalid URL. Include https:// protocol.',
            severity: 'critical'
        });
    }
}

function analyzeImage(imageInfo, platform, results) {
    // File size
    results.totalChecks++;
    const maxSize = 5 * 1024 * 1024;
    if (imageInfo.size > maxSize) {
        results.warnings.push({
            title: 'Large Image File',
            description: `Image is ${Math.round(imageInfo.size / 1024 / 1024)}MB. Compress to <2MB.`,
            severity: 'medium'
        });
    } else {
        results.passedChecks++;
    }

    // File type
    results.totalChecks++;
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(imageInfo.type)) {
        results.violations.push({
            title: 'Unsupported Image Format',
            description: 'Use JPG, PNG, or WebP.',
            severity: 'high'
        });
    } else {
        results.passedChecks++;
        results.passed.push({
            title: '✅ Valid Image Format',
            description: `Format (${imageInfo.type}) supported.`
        });
    }

    // Meta image text policy
    if (platform === 'meta' || platform === 'both') {
        results.totalChecks++;
        results.warnings.push({
            title: 'Meta Image Text Policy (20% Rule)',
            description: 'Ensure text in image is <20% of area. Use Meta Text Overlay Tool.',
            severity: 'high'
        });
    }
}

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Real Estate Ad Compliance Checker running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
