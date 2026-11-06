          />
        </label>
      </div>
      {provider === 'instabox' && (
        <div className="banner banner-warn">
          Before connecting to an instabox server, make sure you have the instabox CLI installed and logged in.
          <br />
          You can install it from: https://instabox.sh/
        </div>
      )}
      {error && <div className="banner banner-error">{error}</div>}