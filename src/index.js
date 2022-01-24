// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://049033a21ea544279162edfaddad3983:d062b0ced31347fba1d46cad6786b065@sentry.cozycloud.cc/75'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveFiles,
  log,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

module.exports = new BaseKonnector(start)

const vendor = 'foncia'
const baseUrl = 'https://myfoncia.fr'

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching list of properties')
  const propertiesIds = await getPropertiesIDs()
  log('info', 'Fetching bills')
  const bills = await fetchBills(propertiesIds)
  log('info', 'Saving data to Cozy')
  await saveFiles(bills, fields.folderPath, {
    identifiers: [vendor],
    concurrency: 8
  })
}

async function authenticate(username, password) {
  const url = `${baseUrl}/login`

  // We need to extract a CSRF token
  let $ = await request(url)
  const _csrf_token = $("input[name='_csrf_token']").attr('value')

  if (!_csrf_token) {
    throw new Error(errors.VENDOR_DOWN)
  }

  $ = await request.post(`${baseUrl}/login_check`, {
    form: {
      _username: username,
      _password: password,
      _csrf_token
    }
  })

  if (!$(`a[href='/logout']`).length === 1) {
    log('error', $('.error').text())
    throw new Error(errors.LOGIN_FAILED)
  }
}

// Get the IDs of the different properties one could own/rent.
async function getPropertiesIDs() {
  const $ = await request(`${baseUrl}/espace-client/espace-de-gestion/mon-bien`)

  return $('.MyPropertiesSelector-slides li')
    .map(function(i, el) {
      return $(el).attr('data-property')
    })
    .get()
}

// Retrieve the "bills" for a given property.
async function getBillsForProperty(propertyId) {
  const page = await request(
    `${baseUrl}/espace-client/espace-de-gestion/mon-bien/${propertyId}`
  )

  const propertyDesc = page(`span[class="MyPropertiesSelector-item-desc"]`)
    .first()
    .text()

  // "Go" to the page where all the documents are accessible.
  const documentsUrl = page(`a[class='Icon--book']`).attr('href')

  if (!documentsUrl) {
    log('error', 'could not find documents url')
    throw new Error(errors.VENDOR_DOWN)
  }

  const $ = await request(`${baseUrl}${documentsUrl}`)

  const bills = scrape(
    $,
    {
      description: {
        sel: '.TeaserRow-desc'
      },
      // The format of the date is: DD.MM.YYYY
      date: {
        sel: '.TeaserRow-date',
        parse: function(text) {
          if (text !== '') {
            return normalizeDate(text)
          } else {
            return text
          }
        }
      },
      billPath: {
        sel: '.Download',
        attr: 'href'
      }
    },
    '.TeaserRow'
  )

  return bills.map(bill => ({
    ...bill,
    propertyDesc
  }))
}

async function fetchBills(propertiesIds) {
  const bills = []
  for (let propertyId in propertiesIds) {
    if (propertyId !== '') {
      bills.push.apply(bills, await getBillsForProperty(propertyId))
    }
  }

  return bills
    .filter(bill => bill.billPath)
    .map(bill => ({
      ...bill,
      currency: '€',
      fileurl: `${baseUrl}${bill.billPath}`,
      vendor,
      filename: `${formatFilename(bill)}.pdf`,
      metadate: {
        importDate: new Date(),
        version: 1
      }
    }))
}

// Return a string representation of the date that follows this format:
// "YYYY-MM-DD". Leading "0" for the day and the month are added if needed.
function formatDate(date) {
  let month = date.getMonth() + 1
  if (month < 10) {
    month = '0' + month
  }

  let day = date.getDate()
  if (day < 10) {
    day = '0' + day
  }

  let year = date.getFullYear()

  return `${year}${month}${day}`
}

// Return a JS Date object from the string representation. The format of the String has
// to be "DD.MM.YYYY".
function normalizeDate(date) {
  let [day, month, year] = date.split('.')
  return new Date(`${year}-${month}-${day}`)
}

// Return an appropriate filename given a "bill": some do not have a date
// associated with it.
function formatFilename(bill) {
  if (bill.date === '') {
    return `${bill.propertyDesc}-${bill.description}`
  } else {
    return `${bill.propertyDesc}-${formatDate(bill.date)}-${bill.description}`
  }
}
