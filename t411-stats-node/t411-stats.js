var program = require('commander');

program
    .version('0.0.1')
    .usage('(-u|--username) <username> (-p|--password) <password> [options]')
    .option('-u, --username <username>', 'set your T411 username')
    .option('-p, --password <password>', 'set your T411 password')
    .option('-d, --debug', 'Affiche les logs de débuggage')
    .parse(process.argv);

var mongoose    = require('mongoose');
var request     = require('request');
var winston     = require('winston');
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({ level: (program.debug)?'debug':'info' })
        //new (winston.transports.File)({ filename: 'somefile.log' })
    ]
});

var mongoUri    = 'mongodb://localhost/';
var dbName      = 't411-stats';
var dbUri       = mongoUri+dbName;

var TStats      = function(dbUri) {
    this.apiCredentials = {
        username    : '',
        password    : ''
    };
    this.dbUri  = dbUri;
    mongoose.connect(dbUri);
    this.db     = mongoose.connection;
    this.db.on('connect', console.error.bind(console, 'connection error:'));
    return;
    this.db.once('open', function() {
        console.log('opened')
    });
};
TStats.prototype= {
    apiUri      : 'https://api.t411.me',
    apiCredentials: null,
    dbUri       : "",
    db          : null,
    schemas     : {
        user        : new mongoose.Schema({
            _id         : {type:Number, min:0},
            name        : String
        }),

        category    : new mongoose.Schema({
            _id         : {type:Number, min:0},
            pid         : {type:Number, min:0},
            name        : String
        }),

        torrentEntry: new mongoose.Schema({
            _id         : {type:Number, min:0},
            added       : Date,
            isVerified  : Boolean,
            size        : {type:Number, min:0}
        }),

        torrentStatus   : new mongoose.Schema({
            name        : String,
            qtComments  : {type:Number, min:0},
            qtSeeders   : {type:Number, min:0},
            qtLeechers  : {type:Number, min:0},
            date        : Date,
            qtCompleted : {type:Number, min:0}
        })
    },
    models      : null,

    updateToken : function(onSuccess, onError) {
        logger.info("Authentification de l'utilisateur '%s'", this.apiCredentials.username);
        var r   = request({
            uri     : (this.apiUri+'/auth'),
            method  : 'POST',
            form    : this.apiCredentials
        }, function(error, response, body) {
            var authResult  = JSON.parse(body);
            if (authResult.error) {
                logger.warn("L'authentification a échouée: (%d) %s", authResult.code, authResult.error);
                if (typeof onError ==='function') onError();
            } else {
                logger.info("Authentification réussie");
                this.apiCredentials.token = authResult.token;
                if (typeof onSuccess ==='function') onSuccess();
            }

        }.bind(this));
    },

    prebuildApiRequest  : function(path) {
        return {
            uri         : this.apiUri+path,
            headers     : { 'Authorization': this.apiCredentials.token}
        };
    },

    updateCategories : function(callback) {
        logger.info("Démarrage de la mise à jour des catégories");
        var reqOpt = this.prebuildApiRequest('/categories/tree');
        request(reqOpt, function(error, response, body) {
            var reqResult   = JSON.parse(body);
            var catCounter  = 0;
            for (var mainCat in reqResult) {
                for (var subCat in reqResult[mainCat]) {
                    var aSubCat = reqResult[mainCat][subCat]; catCounter++;
                    var mCat    = new this.models.category({_id:aSubCat.id, pid:aSubCat.pid, name:aSubCat.name});
                    mCat.save(logger.error.bind(logger, "La catégorie '%s' n'a pu être ajoutée", aSubCat.name));
                }
            }
            logger.info("%d catégories ont été récupérées et enregistrées", catCounter);

            if (typeof callback ==='function') callback();
        }.bind(this));
    }
};
(function () {
    var s = this.schemas;
    this.models = {
        category    : mongoose.model('category',    s.category),
        user        : mongoose.model('users',       s.user),
        torrent     : mongoose.model('torrents',    s.torrentEntry),
        status      : mongoose.model('status',      s.torrentStatus)
    };
}.bind(TStats.prototype))();

var t=new TStats(dbUri);
t.apiCredentials.username = program.username;
t.apiCredentials.password = program.password;
t.updateToken(
    t.updateCategories.bind(t, process.exit.bind(process, 0)));