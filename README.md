# Abi The Chef

This site includes a dependency-free Node.js server that serves the website and sends consultation requests directly from the form through an SMTP account.

## Email configuration

Set these environment variables in the production hosting environment:

| Variable | Required | Description |
| --- | --- | --- |
| `SMTP_HOST` | Yes | SMTP server hostname. |
| `SMTP_PORT` | No | TLS SMTP port; defaults to `465`. |
| `SMTP_USER` | Yes | SMTP account username. |
| `SMTP_PASS` | Yes | SMTP password or provider-issued app password. |
| `SMTP_FROM` | No | Verified sender address; defaults to `SMTP_USER`. |
| `CONTACT_TO` | No | Consultation recipient; defaults to `hello@abithechef.com`. |
| `SMTP_HELO` | No | Hostname used for the SMTP greeting; defaults to `abithechef.com`. |
| `PORT` | No | Web server port; defaults to `3000`. |

The SMTP server must support implicit TLS, normally on port 465. Keep credentials in the hosting provider's environment-variable or secrets settings; never add them to this repository.

## Run

No package download or install step is required. With the environment variables configured, start the site with:

```sh
npm start
```

The contact endpoint validates submissions, applies basic per-IP rate limiting and bot filtering, and sends the message with the visitor's address in `Reply-To`.

## Site images

Place production and staging image assets in an `images` directory at the repository root. Image filenames are case-sensitive in most hosting environments, and the files must be committed to the deployed branch.

The homepage currently expects these files:

- `images/abi-chef-hero.jpg`
- `images/private-dinner-table.jpg`
- `images/abi-portrait.jpg`
- `images/dish-1.jpg`
- `images/scallop.jpg`
- `images/dish-3.jpg`
- `images/gallery-1.jpg`

Before deploying, confirm an image is tracked with `git ls-files images/abi-chef-hero.jpg`. The site uses document-relative image URLs so previews also work when staging is hosted below a path such as `/abi-the-chef/`.
