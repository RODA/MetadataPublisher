needed <- c("DDIwR", "admisc", "declared", "haven", "jsonlite")
missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0) {
    cat(paste(missing, collapse = ","))
    quit(status = 1)
}
cat("ok")
