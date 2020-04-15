const AWS = require('aws-sdk');
const FS = require('fs');
const HTTPS = require('https');
const DB = new AWS.DynamoDB();

const CAPTCHA_SECRET = '...';
const DBNAME = "MinkeHuman";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const captchaPage = FS.readFileSync(`${__dirname}/Captcha.html`, { encoding: 'utf8' });

exports.handler = async (event, context) => {

  console.log(event, context);

  switch (event.path) {
    case '/captcha':
      return captcha(event, context);

    case '/verify':
      return verify(event, context);

    default:
      return '';
  }
};

async function captcha() {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html'
    },
    body: captchaPage
  };
}

async function verify(event, context) {

  const client = event.queryStringParameters.key;
  const token = event.queryStringParameters.token;

  console.log(client, token);

  if (!GUID.test(client)) {
    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json'
      },
      body: 'bad client format'
    };
  }

  const validToken = await new Promise(resolve => {
    const data = `secret=${CAPTCHA_SECRET}&response=${token}`;
    const req = HTTPS.request({
      method: 'POST',
      hostname: 'www.google.com',
      path: '/recaptcha/api/siteverify',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length
      }
    }, res => {
      if (res.statusCode !== 200) {
        resolve(false);
      }
      else {
        res.on('data', d => {
          const answer = JSON.parse(d.toString('utf8'));
          resolve(answer.success);
        });
      }
    });
    req.write(data);
    req.end();
  });

  console.log('validToken', validToken);

  if (!validToken) {
    return {
      statusCode: 500,
      headers: {
      'content-type': 'application/json'
      },
      body: 'invalid token'
    }
  }

  const okay = await new Promise(resolve => {
    DB.updateItem({
      TableName: DBNAME,
      Key: {
        Client: { S: client }
      },
      UpdateExpression: `SET Human = :human, Created = if_not_exists(Created, :now), Updated = :now`,
      ExpressionAttributeValues: {
        ':human': { S: 'google-captcha-v2' },
        ':now': { N: `${Date.now()}` }
      },
    }, (err, data) => {
      resolve(err ? false : true);
    });
  });

  return {
    statusCode: okay ? 200 : 500,
    headers: {
      'content-type': 'application/json'
    },
    body: okay ? 'okay' : 'unknown error'
  };
};
