require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require('express-session');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require("express-rate-limit");
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const stripe = Stripe(process.env.STRIPE_PRIVATE_KEY);

const transporter = nodemailer.createTransport({
    service: 'gmail', // or another service
    auth: {
        user: process.env.EMAIL_USER, // your email address
        pass: process.env.EMAIL_PASS  // your email password
    }
});


// Initialize Express
const app = express();

app.set('trust proxy', 1); // 1 indicates trusting the first proxy

app.use(express.static(path.join(__dirname, 'Client_pc/Client/dist')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'Client_pc/Client/dist', 'index.html'));
});

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Import the Review model
const Review = require('./models/Review');

// Update the static file serving middleware
app.use('/Media', express.static(path.join(__dirname, 'Media')));

// Enhanced security headers
app.use(helmet());


app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // Log the session object for debugging purposes
        console.log('Session Object:', session);

        // Ensure the shipping details exist under shipping_details
        const shippingAddress = session.shipping_details?.address;
        if (!shippingAddress) {
            console.error('No shipping address found in session');
            return res.status(400).send('No shipping address found');
        }

        
        
        
        // Retrieve the customer email from customer_details
        const customerEmail = session.customer_details?.email;
        if (!customerEmail) {
            console.error('No customer email found in session');
            return res.status(400).send('No customer email found');
        }

        let line_items = await stripe.checkout.sessions.listLineItems(session.id);
        const formattedLineItems = line_items.data.map(item => {
            return `${item.quantity} x ${item.description}`; // assuming 'description' holds the item name
        }).join(', ');
        
        try {
            // Retrieve line items from the checkout session if necessary
            const checkoutSession = await stripe.checkout.sessions.retrieve(session.id);
            console.log('Line Items:', line_items.data);
        } catch (error) {
            console.error('Error retrieving line items:', error);
            return res.status(500).send('Internal Server Error');
        }

        try {
            // Call your function to create a FedEx order

            // Send an email confirmation to the customer
            const mailUser = {
                from: process.env.EMAIL_USER,
                to: customerEmail,
                subject: 'Order Confirmation',
                text: 'Thank you for your order! Your order is being processed.',
            };

            const mailCompany = {
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: 'Order Confirmation',
                text: `An order for ${formattedLineItems} has been placed. The customer would like his order shipped to ${JSON.stringify(shippingAddress)}. His/her email is ${customerEmail}.`,
            };

            await transporter.sendMail(mailUser);
            await transporter.sendMail(mailCompany);
            console.log('Email sent to:', customerEmail);
        } catch (error) {
            console.error('Error creating FedEx order or sending email:', error);
            return res.status(500).send('Internal Server Error');
        }
    }

    res.json({ received: true });
});




// Body parsing middleware
app.use(express.json());

// Middleware to parse plain text bodies
app.use(bodyParser.text({ type: 'text/plain' }));
app.use(bodyParser.json());

// Session management
app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true,
        sameSite: 'strict'
    }
}));

// CORS configuration
const allowedOrigins = [process.env.CLIENT_URL, 'https://checkout.stripe.com'];
app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

// FedEx API configuration
const FEDEX_API_URL = 'https://apis-sandbox.fedex.com';
const FEDEX_CLIENT_ID = process.env.FEDEX_CLIENT_ID;
const FEDEX_CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET;

// Function to get FedEx access token
async function getFedExAccessToken() {
    try {
        const response = await axios.post(`${FEDEX_API_URL}/oauth/token`, 
            `grant_type=client_credentials&client_id=${FEDEX_CLIENT_ID}&client_secret=${FEDEX_CLIENT_SECRET}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting FedEx access token:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// FedEx tracking endpoint
app.post('/track', async (req, res) => {
    try {
        const { trackingNumber } = req.body;
        const accessToken = await getFedExAccessToken();
        
        const trackingResponse = await axios.post(`${FEDEX_API_URL}/track/v1/trackingnumbers`, {
            trackingInfo: [
                {
                    trackingNumberInfo: {
                        trackingNumber: trackingNumber
                    }
                }
            ]
        }, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        res.json(trackingResponse.data);
    } catch (error) {
        console.error('Error fetching tracking data:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch tracking data' });
    }
});

async function getFedExAccessTokenRest() {
    try {
        const response = await axios.post(`${FEDEX_API_URL}/oauth/token`, 
            `grant_type=client_credentials&client_id=${process.env.FEDEX_CLIENT_ID_REST}&client_secret=${process.env.FEDEX_CLIENT_SECRET_REST}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting FedEx access token:', error.response ? error.response.data : error.message);
        throw error;
    }
}



async function validateAddressFedEx(address) {
    const accessToken = await getFedExAccessTokenRest(); // Ensure this function works and returns the token.

    const data = {
        "addressesToValidate": [
        {
        "address": {
        "streetLines": [
        "7372 PARKRIDGE BLVD",
        "APT 286"
        ],
        "city": "IRVING",
        "stateOrProvinceCode": "TX",
        "postalCode": "75063-8659",
        "countryCode": "US"
        }
        }
        ]
        }

    try {
        const response = await axios.post('https://apis-sandbox.fedex.com/address/v1/addresses/resolve', data, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,  // Ensure the access token is valid
                'Content-Type': 'application/json',
            }
        });

        // Check if the response contains validation results
        const validationResults = response.data.output?.addressResults;

        // Check the validation status
        if (validationResults && validationResults[0]?.resolved) {
            const classification = validationResults[0].classification;
            console.log('Address classification:', classification);

            return classification === 'VALID';  // Returns true if the address is valid
        }

        return false;  // If no results or not valid, return false
    } catch (error) {
        console.error('Error validating address with FedEx:', error.response?.data || error.message);
        return false;
    }
}



async function getShippingCost(shippingAddress, packageDetails) {
    const response = await axios.post('https://fedex-api-url.com/rates', {
        // Fill in with appropriate FedEx API request details
        account_number: process.env.FEDEX_ACCOUNT_NUMBER,
        destination: shippingAddress,
        package: packageDetails,
    });

    const shippingCost = response.data.rate; // Adjust according to FedEx API response
    return shippingCost;
}

const createFedExOrder = async (lineItems, customerEmail) => {
    // Fetch the access token
    const tokenResponse = await axios.post(
        'https://apis-sandbox.fedex.com/oauth/token',
        'grant_type=client_credentials' +
        '&client_id=' + encodeURIComponent(process.env.FEDEX_CLIENT_ID_REST) +
        '&client_secret=' + encodeURIComponent(process.env.FEDEX_CLIENT_SECRET_REST),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );

    const accessToken = tokenResponse.data.access_token;

    // Prepare the order details
    const orderDetails = {
        accountNumber: process.env.FEDEX_ACCOUNT_NUMBER,
        requestedShipment: {
            shipper: {
                contact: {
                    personName: 'John Taylor',
                    phoneNumber: '1234567890',
                    companyName: 'BLDG',
                },
                address: {
                    streetLines: ["10 FedEx Parkway","Suite 302"],
                    city: 'Cary',
                    stateOrProvinceCode: 'NC',
                    postalCode: '90210e',
                    countryCode: 'US',
                },
            },
            recipient: {
                contact: {
                    personName: 'John Taylor',
                    phoneNumber: '0987654321',
                    companyName: 'Loli',
                },
                address: {
                    streetLines: ["10 FedEx Parkway","Suite 302"],
                    city: 'Cary',
                    stateOrProvinceCode: 'NC',
                    postalCode: '90210',
                    countryCode: 'US',
                },
            },
            packages: [
                {
                    weight: {
                        units: 'LB',
                        value: 5.0,
                    },
                    dimensions: {
                        length: 10,
                        width: 10,
                        height: 10,
                        units: 'IN',
                    },
                },
            ],
            serviceType: 'FEDEX_GROUND',
            packagingType: 'FEDEX_ENVELOPE',
        },
    };

    // Convert orderDetails to JSON
    const data = JSON.stringify(orderDetails);

    try {
        const fedexResponse = await axios.post(
            'https://apis-sandbox.fedex.com/ship/v1/shipments',
            orderDetails,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-locale': 'en_US',
                },
            }
        );
    
        if (fedexResponse.status === 200) {
            console.log('FedEx order created successfully:', fedexResponse.data);
        } else {
            console.error('Failed to create FedEx order:', fedexResponse.data);
        }
    } catch (error) {
        if (error.response) {
            console.error('Error in FedEx order creation:', error.response.data);
    
            if (error.response.data.errors) {
                error.response.data.errors.forEach(err => {
                    console.error(`Error Code: ${err.code} - Message: ${err.message}`);
                });
            }
        } else {
            console.error('Error in FedEx order creation:', error.message);
        }
    }
    
};


// API rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again after 15 minutes"
});
app.use(limiter);

// Reviews API routes
app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find();
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

app.post('/api/reviews', async (req, res) => {
    try {
        const { title, content, rating, product } = req.body;
        if (!title || !content || !rating || !product) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const newReview = new Review({
            title,
            content,
            rating,
            productName: product,
            reviewType: 'product'
        });

        await newReview.save();
        res.status(201).json(newReview);
    } catch (err) {
        console.error('Failed to save review:', err.message);
        res.status(400).json({ error: 'Failed to save review' });
    }
});

app.post('/api/reviews/usefulness', async (req, res) => {
    const { reviewId, userUUID, type } = req.body;

    if (!userUUID || !type || !['like', 'dislike', 'remove'].includes(type)) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    try {
        const review = await Review.findById(reviewId);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        const currentVote = review.userVotes.get(userUUID);

        if (type === 'remove') {
            if (!currentVote) {
                return res.status(400).json({ error: 'No vote to remove' });
            }

            if (currentVote === 'like') {
                review.thumbsUp -= 1;
            } else if (currentVote === 'dislike') {
                review.thumbsDown -= 1;
            }

            review.userVotes.delete(userUUID);

        } else if (currentVote) {
            if (currentVote === type) {
                if (type === 'like') {
                    review.thumbsUp -= 1;
                } else if (type === 'dislike') {
                    review.thumbsDown -= 1;
                }

                review.userVotes.delete(userUUID);
            } else {
                if (currentVote === 'like') {
                    review.thumbsUp -= 1;
                } else if (currentVote === 'dislike') {
                    review.thumbsDown -= 1;
                }

                if (type === 'like') {
                    review.thumbsUp += 1;
                } else if (type === 'dislike') {
                    review.thumbsDown += 1;
                }

                review.userVotes.set(userUUID, type);
            }

        } else {
            if (type === 'like') {
                review.thumbsUp += 1;
            } else if (type === 'dislike') {
                review.thumbsDown += 1;
            }

            review.userVotes.set(userUUID, type);
        }

        const updatedReview = await review.save();
        res.json(updatedReview);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update review usefulness' });
    }
});

app.post('/api/reviews/:id/vote', async (req, res) => {
    try {
        const { voteType } = req.body;
        const review = await Review.findById(req.params.id);

        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        if (voteType === 'like') {
            review.thumbsUp += 1;
        } else if (voteType === 'dislike') {
            review.thumbsDown += 1;
        } else {
            return res.status(400).json({ error: 'Invalid vote type' });
        }

        await review.save();
        res.json({ thumbsUp: review.thumbsUp, thumbsDown: review.thumbsDown });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update vote' });
    }
});

// Stripe Checkout route
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { items, customerEmail } = req.body;
        const products = require('./products.js');
        
        // Create a Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: items.map(item => {
                // Look up the product details by ID
                const product = Object.values(products).find(p => p.id === item.id);
                if (!product) {
                    throw new Error(`Product with ID ${item.id} not found`);
                }
        
                return {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: product.name, // Fetch the product name from the products object
                        },
                        unit_amount: product.price * 100, // Convert price to cents
                    },
                    quantity: item.quantity, // Keep quantity from the frontend
                };
            }),
            mode: 'payment',
            success_url: `${process.env.CLIENT_URL}/Success`,
            cancel_url: `${process.env.CLIENT_URL}/Cancel`,
            customer_email: customerEmail, // Ensure this is set
            shipping_address_collection: {
                allowed_countries: ['US'], // Add countries as needed
            },
        });

        res.json({ id: session.id });
    } catch (error) {
        console.error('Error creating Checkout Session:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'An internal error occurred' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
