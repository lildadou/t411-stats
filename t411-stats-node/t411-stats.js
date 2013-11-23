var program = require('commander');

program
    .version('0.0.1')
    .usage('(-u|--username) <username> (-p|--password) <password>')
    .option('-u, --username <username>', 'set your T411 username')
    .option('-p, --password <password>', 'set your T411 password')
    //.option('-T, --no-tests', 'ignore test hook')
    .parse(process.argv);

var mongoose    = require('mongoose');
var request     = require('request');
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
    apiUri      : 'https://api.t411.me/',
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
    test        : function() {
        var cat = new this.models.category({_id:666, name:"lolcat"});
        cat.save(function(err) {
            if (err) console.error('Ajouté categorie a échoué');
            else console.log('Catégorie lolcat ajoutée');
        })
    },
    updateToken : function() {
        var r   = request({
            uri     : (this.apiUri+'auth'),
            method  : 'POST',
            form    : this.apiCredentials
        }, function(error, response, body) {
            var authResult  = JSON.parse(body);
            if (authResult.error) {
                console.log("L'authentification a échouée: (%s) %s", authResult.code, authResult.error);
            } else {
                console.log("Authentification réussie");
                this.apiCredentials.token = authResult.token;
            }
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
t.updateToken();