
packages <- c("jsonlite", "DDIwR")

missing <- sapply(packages, function(x) {
    tryCatch(packageVersion(x), error = function(e) "0") == "0"
})

if (any(missing)) {
    cat(jsonlite::toJSON(
        list(
            type = "init",
            status = "error",
            missing = as.list(names(missing)[missing])
        ),
        auto_unbox = TRUE
    ), "\n", sep = "")

} else {
    suppressPackageStartupMessages({
        library(jsonlite)
        library(DDIwR)
    })

    appdirname <- tryCatch(
        dirname(normalizePath(sys.frames()[[1]]$ofile)),
        error = function(e) getwd()
    )

    try(
        source(
            file.path(
                appdirname,
                "utils.R"
            )
        ),
        silent = TRUE
    )

    rm(appdirname)

    cat(jsonlite::toJSON(
        list(
            type = "init",
            status = "ok"
        ),
        auto_unbox = TRUE
    ), "\n", sep = "")
}

rm(packages, missing)

flush(stdout())
invisible(NULL)




# packages <- c("jsonlite", "DDIwR", "admisc", "declared", "haven")

# missing <- sapply(packages, function(x) {
#     tryCatch(packageVersion(x), error = function(e) "0") == "0"
# })

# if (any(missing)) {
#     missing_array <- paste0(
#         "['",
#         paste(packages[missing], collapse = "', '"),
#         "']"
#     )

#     cat(paste(
#         "{",
#             "'type': 'init',",
#             "'status': 'error',",
#             "'missing':", missing_array,
#         "}\n"
#     ))
# } else {
#     suppressPackageStartupMessages({
#         library(jsonlite)
#         library(DDIwR)
#     })

#     cat("{'type': 'init', 'status': 'ok'}\n")
# }

# invisible(NULL)


# packages <- c("jsonlite", "DDIwR")
# missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]

# emit_json <- function(obj) { cat(jsonlite::toJSON(obj, auto_unbox = TRUE), "\n", sep = "") ; flush(stdout()) }

# if (length(missing) > 0) {
#     emit_json(list(type = "init", status = "error", missing = unname(missing)))
#     invisible(NULL)
# } else {
#     suppressPackageStartupMessages({
#         library(jsonlite); library(DDIwR)
#     })
#     # Resolve the directory of this file and source utils.R from the same folder
#     .mp_dir <- tryCatch(dirname(normalizePath(sys.frames()[[1]]$ofile)), error = function(e) getwd())
#     try({ source(file.path(.mp_dir, "utils.R")) }, silent = TRUE)
#     emit_json(list(type = "init", status = "ok"))
#     invisible(NULL)
# }

