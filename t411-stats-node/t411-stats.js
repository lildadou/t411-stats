var program = require('commander');

program
    .version('0.0.1')
    .usage('(-u|--username) <username> (-p|--password) <password> [options]')
    .option('-u, --username <username>', 'set your T411 username')
    .option('-p, --password <password>', 'set your T411 password')
    .option('-F, --flush', 'Vide la base de donnée')
    .option('-d, --debug', 'Affiche les logs de débuggage')
    .parse(process.argv);

var mongoose    = require('mongoose');
var request     = require('request');
var qs          = require('qs');
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
    schemas     : {},
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

    updateCategories : function(onSuccess, onError) {
        logger.info("Démarrage de la mise à jour des catégories");
        var reqOpt = this.prebuildApiRequest('/categories/tree');
        request(reqOpt, function(error, response, body) {
            var reqResult   = JSON.parse(body);
            var catCounter  = 0;

            var saveCategory    = function(aServerCat) {
                var mCat    = this.models.category.create({
                    _id :aServerCat.id,
                    pid :aServerCat.pid,
                    name:aServerCat.name}, function(err, savedModel) {
                    if (err) logger.error("La catégorie '%s' n'a pu être ajoutée", aServerCat.name);
                    else logger.debug("La catégorie '%s' a été ajoutée", aServerCat.name);
                });
            };

            // Parcours des catégories principales
            for (var mainCat in reqResult) {
                var aMainCat= reqResult[mainCat]; catCounter++;
                if ( ! aMainCat.id) continue; // Certaines catégorie sont 'fantôme'
                saveCategory.bind(this)(aMainCat);

                // Parcours des sous-catégories
                for (var subCat in aMainCat.cats) {
                    var aSubCat = aMainCat.cats[subCat]; catCounter++;
                    saveCategory.bind(this)(aSubCat);
                }
            }
            logger.info("%d catégories ont été récupérées et enregistrées", catCounter);

            if (typeof onSuccess ==='function') onSuccess();
        }.bind(this));
    },

    monitorLastTorrent  : function(qt, callback) {
        /**Ajoute <qt> torrents qui seront analysés par la suite. Les torrents
         * ajoutés sont les derniers torrent uploadés. Les torrents déjà surveillés
         * seront comptabilisés.
         * @param qt {Number} */
        logger.info('Démarrage de l\'échantillonnage (taille=%d)', qt);
        var reqOpt  = this.prebuildApiRequest('/torrents/search/');
        reqOpt.qs   = {limit:qt};
        var r= request(reqOpt, function(error, response, body) {
            var reqResult   = JSON.parse(body.split('\n')[3]);
            var lastTorrents= reqResult.torrents;
            for (var itTorrent=0; itTorrent < lastTorrents.length; itTorrent++) {
                var tInfo   = this.extractTorrentInfos(lastTorrents[itTorrent]);
                this.addTorrentEntry(tInfo.entry, function(isSuccess) {
                    if (isSuccess) this.addTorrentStatus(tInfo.status);
                }.bind(this));
            }
            if (typeof callback ==='function') callback();
        }.bind(this));
     },

    extractTorrentInfos : function(tJson) {
        var result  = { entry:{}, status:{}};
        if (typeof tJson ==='number') {
            result.status.isPended = true;
            result.entry._id = tJson;
        } else {
            result.entry = {
                _id         : (new Number(tJson.id)).valueOf(),
                added       : new Date(tJson.added),
                size        : (new Number(tJson.size)).valueOf(),
                category    : {_id:(new Number(tJson.category)).valueOf()},
                owner       : {_id:(new Number(tJson.owner)).valueOf(), name:tJson.username}
            };

            result.status= {
                torrent     : {_id:(new Number(tJson.id)).valueOf()},
                name        : tJson.name,
                isVerified  : (tJson.isVerified=='1'),
                isPended    : false,
                qtComments  : (new Number(tJson.comments)).valueOf(),
                qtSeeders   : (new Number(tJson.seeders)).valueOf(),
                qtLeechers  : (new Number(tJson.leechers)).valueOf(),
                date        : Date.now(),
                qtCompleted : (new Number(tJson.times_completed)).valueOf()
            };
        }
        return result;
    },

    addTorrentEntry  : function(entry, callback) {
        /**Ajout un torrent suivi dans la base
         * @param entry {Object}
         */
        // On vérifie que le torrent n'existe pas déja
        this.models.torrent.findById(entry._id, function(err, oldEntry) {
            if (oldEntry) {
                logger.info('Le torrent %d n\'a pas été ajouté (doublon)', entry._id);
                if (typeof callback==='function') callback(false);
            } else {
                this.models.torrent.create(entry, function(err, savedTorrent) {
                    if (err) logger.error('Le torrent %d n\'a pu être ajouté', entry._id);
                    else logger.info('Le torrent %d a été ajouté', savedTorrent._id);
                    if (typeof callback==='function') callback(err==null);
                });
            }
        }.bind(this));
    },

    addTorrentStatus    : function(status) {
        /**Ajout d'une entrée de status d'un torrent
         * @param status {Object}
         */
        this.models.status.create(status,  function(err, savedStatus) {
            if (err) logger.error('Le status du torrent %d n\'a pu être ajouté', status.torrent._id);
            else logger.info('Le status du torrent %d a été ajouté', savedStatus.torrent);
        });
    },

    /**Cette méthode vide la base de donnée.
     * @param callback {Function} Fonction appellée lorsque l'opération est terminée
     */
    flushDatabase   : function(callback) {

        logger.warn('Suppression de la base de donnée!');
        for (var m in this.models) this.models[m].remove().exec();
    }
};
(function () {
    var s = this.schemas;
    s.user  = new mongoose.Schema({
        _id         : {type:Number, min:0},
        name        : String
    });

    s.category = new mongoose.Schema({
        _id         : {type:Number, min:0},
        pid         : {type:Number, min:0},
        name        : String
    });

    s.torrentStatus= new mongoose.Schema({
        torrent     : {type:Number, ref: 'torrent'},
        name        : String,
        isVerified  : Boolean,
        isPended    : Boolean,
        qtComments  : {type:Number, min:0},
        qtSeeders   : {type:Number, min:0},
        qtLeechers  : {type:Number, min:0},
        date        : Date,
        qtCompleted : {type:Number, min:0}
    });

    s.torrentEntry= new mongoose.Schema({
        _id         : {type:Number, min:0},
        added       : Date,
        size        : Number,
        category    : {type:Number, ref: 'category'},
        owner       : {type:Number, ref: 'user'},
        status      : {type:mongoose.Schema.Types.ObjectId, ref: 'status'}
    });

    this.models = {
        category    : mongoose.model('category',    s.category),
        user        : mongoose.model('user',        s.user),
        torrent     : mongoose.model('torrent',     s.torrentEntry),
        status      : mongoose.model('status',      s.torrentStatus)
    };
}.bind(TStats.prototype))();

var t=new TStats(dbUri);
t.apiCredentials.username = program.username;
t.apiCredentials.password = program.password;

if (program.flush) {
    t.flushDatabase();  setTimeout(process.exit.bind(process, 0),2000); return;
} else {
    t.updateToken(
        t.updateCategories.bind(t,
            t.monitorLastTorrent.bind(t, 1/*,
             setTimeout.bind(this, process.exit.bind(process, 0),2000)*/)));
}
